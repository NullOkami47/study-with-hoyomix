"""Local SQLite comparison of the pinned legacy and current retention SQL.

Run from D: on Windows. No network, Cloudflare credentials or third-party modules.
VM instructions are SQLite progress-handler counts, NEVER D1 billed rows/visits.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import statistics
import subprocess
import time
from pathlib import Path

NOW = 2_000_000
TABLES = ['chat_messages', 'chat_message_versions', 'chat_reports', 'chat_request_receipts', 'moderation_actions']


class Meter:
    def __init__(self, db):
        self.db, self.records = db, []

    def run(self, sql, args=()):
        ticks = 0
        def progress():
            nonlocal ticks
            ticks += 1
            return 0
        self.db.set_progress_handler(progress, 1)
        before = self.db.total_changes
        start = time.perf_counter_ns()
        rows = self.db.execute(sql, args).fetchall()
        duration = (time.perf_counter_ns() - start) / 1e6
        self.db.set_progress_handler(None, 0)
        self.records.append(dict(sql=sql, args=args, vm_instructions=ticks,
                                 duration_ms=duration, total_changes=self.db.total_changes-before))
        return rows


def quoted_prepares(text):
    return re.findall(r'\.prepare\(\s*["`]([^"`]+)["`]\s*,?\s*\)', text)


def load_sql(root, baseline):
    old = subprocess.check_output(['git', 'show', f'{baseline}:workers/chat/repository.ts'], cwd=root, text=True)
    room = subprocess.check_output(['git', 'show', f'{baseline}:workers/chat/ChatRoom.ts'], cwd=root, text=True)
    current = (root/'workers/chat/retention.ts').read_text(encoding='utf-8')
    migration = (root/'migrations/0030_chat_retention.sql').read_text(encoding='utf-8')
    legacy = quoted_prepares(old.split('export async function prune(')[1])
    schedule = next(x for x in quoted_prepares(room) if x.startswith('SELECT MIN(expires_at)'))
    sql = quoted_prepares(current)
    lookup = lambda prefix: next(x for x in sql if x.startswith(prefix))
    # Expand only runtime's four exact table/column substitutions and batch constants.
    parent_batch = int(re.search(r'PARENT_BATCH = (\d+)', current)[1])
    child_batch = int(re.search(r'CHILD_BATCH = (\d+)', current)[1])
    message_cap = int(re.search(r'MESSAGE_CAP = (\d+)', current)[1])
    child = lookup('DELETE FROM ${table}')
    deletes = [child.replace('${table}', table).replace('${column}', column).replace('${CHILD_BATCH}', str(child_batch))
               for table, column in [('moderation_actions', 'target_message_id'), ('chat_message_versions', 'message_id'), ('chat_reports', 'message_id')]]
    deletes += [lookup('DELETE FROM chat_request_receipts').replace('${CHILD_BATCH}', str(child_batch)),
                lookup('DELETE FROM chat_messages'), lookup('UPDATE chat_retention_state').replace('${MESSAGE_CAP}', str(message_cap)),
                lookup('DELETE FROM chat_message_versions').replace('${CHILD_BATCH}', str(child_batch))]
    assert len(legacy) == 4 and len(deletes) == 7
    return dict(old=legacy, old_schedule=schedule, current=current, migration=migration,
                count=lookup('SELECT message_count'), overflow=lookup('SELECT id FROM chat_messages WHERE room_id=\'global\' ORDER BY created_at'),
                expired=lookup('SELECT id FROM chat_messages WHERE room_id=\'global\' AND expires_at'),
                version_probe=lookup('SELECT id FROM chat_message_versions'), deletes=deletes,
                schedule=[lookup('SELECT expires_at AS expiry FROM chat_messages'), lookup('SELECT expires_at AS expiry FROM chat_message_versions')],
                cap=message_cap, parent_batch=parent_batch,
                pending=lookup('SELECT message_id AS id'), pending_schedule=lookup('SELECT message_id FROM'),
                pending_insert=lookup('INSERT OR IGNORE INTO chat_retention_pending'))


def schema(root):
    parts = ['CREATE TABLE users(id TEXT PRIMARY KEY);']
    for filename in ['0003_chat.sql', '0004_reports_admin.sql', '0029_community_chat.sql']:
        text = (root/'migrations'/filename).read_text(encoding='utf-8')
        for statement in text.split(';'):
            stmt = statement.strip()
            if any(re.match(r'CREATE TABLE '+table+r'\s*\(', stmt) for table in TABLES):
                parts.append(stmt+';')
            elif stmt.startswith('CREATE INDEX') or stmt.startswith('CREATE UNIQUE INDEX'):
                if any(re.search(r'\bON\s+'+table+r'\b', stmt) for table in TABLES):
                    parts.append(stmt+';')
    return '\n'.join(parts)


def fixture(root, spec, new, sql):
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(schema(root))
    db.execute("INSERT INTO users VALUES('u')")
    n, versions, expired, dependants = spec
    db.executemany('INSERT INTO chat_messages(id,author_display_name,content,created_at,expires_at) VALUES(?,?,?,?,?)',
                   [(f'm{i:06}', 'Fixture', 'message', i, NOW-1 if i < expired else NOW+100_000+i) for i in range(n)])
    # Many dependants on the oldest parent stresses durable partial-parent progress.
    db.executemany('INSERT INTO chat_message_versions(id,message_id,original_content,created_at,expires_at) VALUES(?,?,?,?,?)',
                   [(f'v{i:06}', 'm000000' if dependants else f'm{i % n:06}', 'prior', 0, NOW-1 if expired else NOW+100_000) for i in range(versions)])
    if dependants:
        db.executemany('INSERT INTO chat_reports(id,message_id,reason,status,created_at) VALUES(?,?,?,?,?)',
                       [(f'r{i:06}', 'm000000', 'fixture', 'resolved', 0) for i in range(dependants)])
        db.executemany('INSERT INTO chat_request_receipts VALUES(?,?,?)', [('u',f'q{i:06}','m000000') for i in range(dependants)])
        db.executemany('INSERT INTO moderation_actions(id,target_message_id,action,created_at) VALUES(?,?,?,?)',
                       [(f'a{i:06}','m000000','delete_message',0) for i in range(dependants)])
    db.commit()
    migration = None
    if new:
        m = Meter(db)
        for statement in sql['migration'].split(';'):
            if statement.strip(): m.run(statement)
        db.commit()
        migration = summary(m.records)
    return db, migration


def counts(db):
    return {t: db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in TABLES}


def fingerprint(db):
    data = {t: sorted(db.execute(f'SELECT * FROM {t}').fetchall(), key=repr)
            for t in TABLES+['chat_retention_state','chat_retention_pending']}
    return hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()


def invoke(db, sql, new, fail_at=None, reserve=False):
    m = Meter(db)
    if not new:
        db.execute('BEGIN')
        for i, query in enumerate(sql['old']): m.run(query, (NOW,) if '?' in query else ())
        db.commit()
        m.run(sql['old_schedule'])
        return m
    count = m.run(sql['count'])[0][0]
    overflow = max(0, count-sql['cap']+int(reserve))
    ids = m.run(sql['pending'], (sql['parent_batch'],))
    if not ids:
        ids = m.run(sql['overflow'] if overflow else sql['expired'],
                    (min(sql['parent_batch'], overflow),) if overflow else (NOW, sql['parent_batch']))
    if ids:
        db.execute('BEGIN')
        try:
            m.run(sql['pending_insert'], (json.dumps([r[0] for r in ids]),))
            for i, query in enumerate(sql['deletes']):
                if fail_at == i: raise RuntimeError('injected transaction failure')
                args = () if query.startswith('UPDATE') else (NOW,) if i == 6 else (json.dumps([r[0] for r in ids]),)
                m.run(query, args)
            db.commit()
        except RuntimeError:
            db.rollback()
            raise
    elif m.run(sql['version_probe'], (NOW,)):
        m.run(sql['deletes'][-1], (NOW,))
        db.commit()
    pending = m.run(sql['pending_schedule'])
    if not pending:
        count = m.run(sql['count'])[0][0]
        if count <= sql['cap']:
            for query in sql['schedule']: m.run(query)
    return m


def summary(records):
    return dict(statements=len(records), vm_instructions=sum(r['vm_instructions'] for r in records),
                duration_ms=sum(r['duration_ms'] for r in records),
                sqlite_total_changes=sum(r['total_changes'] for r in records))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out', type=Path, default=Path('D:/hoyomix_preview/chat-final-local-20261017'))
    parser.add_argument('--baseline', default='24e3e8be642cd889072d655a29c5b18aa6b9ca78')
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    if __import__('os').name == 'nt' and (args.root.drive.upper() != 'D:' or args.out.drive.upper() != 'D:'):
        raise SystemExit('All benchmark work must remain on D:')
    sql = load_sql(args.root,args.baseline)
    scenarios = {'empty': (0,0,0,0), '50':(50,0,0,0), '1000':(1000,0,0,0), '10000':(10000,0,0,0),
                 '10005_legacy_overflow':(10005,0,0,0), '10000_20000versions':(10000,20000,0,0),
                 'expired_backlog':(10000,20000,1000,0), 'expired_reports_receipts':(50,350,1,350)}
    output = dict(baseline=args.baseline, sqlite_version=sqlite3.sqlite_version, repeats=args.repeats,
                  warning='SQLite VM counts and logical changes are not D1 billing, rows read, or row visits. Instrumentation affects duration.',
                  source_sha256=hashlib.sha256(sql['current'].encode()).hexdigest(),
                  migration_sha256=hashlib.sha256(sql['migration'].encode()).hexdigest(), scenarios={})
    for name,spec in scenarios.items():
        result={}
        for new in [False,True]:
            runs=[]
            for repeat in range(args.repeats):
                db,migration=fixture(args.root,spec,new,sql)
                before=counts(db)
                meter=invoke(db,sql,new)
                after=counts(db)
                if new: assert db.execute(sql['count']).fetchone()[0] == after['chat_messages']
                item=summary(meter.records)
                item['logical_deletes']={t:before[t]-after[t] for t in TABLES}
                item['counter_row_updates']=sum(r['total_changes'] for r in meter.records if r['sql'].startswith('UPDATE chat_retention_state'))
                if new:
                    item['pending_row_inserts']=sum(r['total_changes'] for r in meter.records if r['sql'].startswith('INSERT OR IGNORE INTO chat_retention_pending'))
                    item['pending_cascade_deletes']=item['logical_deletes']['chat_messages']
                    item['logical_change_budget']=sum(item['logical_deletes'].values())+item['counter_row_updates']+item['pending_row_inserts']+item['pending_cascade_deletes']
                    assert item['logical_deletes']['chat_messages'] <= sql['parent_batch']
                    assert item['logical_deletes']['chat_message_versions'] <= 200
                    assert all(item['logical_deletes'][t] <= 100 for t in ['chat_reports','chat_request_receipts','moderation_actions'])
                    assert item['pending_row_inserts'] <= sql['parent_batch']
                runs.append(item)
                if repeat == 0:
                    plans=[dict(sql=r['sql'],args=r['args'],plan=db.execute('EXPLAIN QUERY PLAN '+r['sql'],r['args']).fetchall()) for r in meter.records]
                    statements=meter.records
                db.close()
            result['new' if new else 'old'] = dict(median_duration_ms=statistics.median(r['duration_ms'] for r in runs),runs=runs,plans=plans,statements=statements,migration=migration)
        # Complete bounded clean-up, evict/reopen between batches, and recover rollback.
        db,_=fixture(args.root,spec,True,sql)
        snap=counts(db)
        before_failure=fingerprint(db)
        failure_start=time.perf_counter_ns()
        failure_injected=False
        try: invoke(db,sql,True,fail_at=4)
        except RuntimeError: failure_injected=True
        failure_ms=(time.perf_counter_ns()-failure_start)/1e6
        rollback_ok = fingerprint(db)==before_failure and counts(db)==snap and db.execute(sql['count']).fetchone()[0]==snap['chat_messages']
        # If no mutation batch exists there is no injected failure to observe.
        recovery=[]
        rebuild_times=[]
        for batch in range(1000):
            before=counts(db)
            meter=invoke(db,sql,True)
            after=counts(db)
            assert db.execute(sql['count']).fetchone()[0]==after['chat_messages']
            recovery.append(summary(meter.records))
            if before==after: break
            # SQLite backup + new connection approximates process reconstruction;
            # no JS Durable Object or Cloudflare storage operation is exercised.
            rebuilt=sqlite3.connect(':memory:')
            rebuild_start=time.perf_counter_ns()
            db.backup(rebuilt)
            rebuilt.execute('PRAGMA foreign_keys=ON')
            db.close(); db=rebuilt
            rebuild_times.append((time.perf_counter_ns()-rebuild_start)/1e6)
        else: raise AssertionError('Recovery did not converge')
        result['recovery']=dict(rollback_preserved_rows=rollback_ok,batches_including_terminal_probe=len(recovery),
                                failure_injected=failure_injected,failure_attempt_duration_ms=failure_ms,
                                rebuild_count=len(rebuild_times),rebuild_total_duration_ms=sum(rebuild_times),
                                total_statements=sum(r['statements'] for r in recovery),total_vm=sum(r['vm_instructions'] for r in recovery),
                                total_duration_ms=sum(r['duration_ms'] for r in recovery),final=counts(db),foreign_key_check=db.execute('PRAGMA foreign_key_check').fetchall())
        assert rollback_ok and not result['recovery']['foreign_key_check']
        db.close()
        output['scenarios'][name]=result
    assert hashlib.sha256((args.root/'workers/chat/retention.ts').read_text(encoding='utf-8').encode()).hexdigest() == output['source_sha256'], 'Runtime changed during benchmark; rerun'
    assert hashlib.sha256((args.root/'migrations/0030_chat_retention.sql').read_text(encoding='utf-8').encode()).hexdigest() == output['migration_sha256'], 'Migration changed during benchmark; rerun'
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/'chat-retention-benchmark.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    lines=['# Chat retention 本機 SQLite benchmark','',f"Baseline `{args.baseline}`；SQLite {sqlite3.sqlite_version}；每場景 {args.repeats} 次。",'',
           'VM 是 progress_handler 每個 opcode 計數；不是 rows visited、D1 rows read/write 或帳單。duration 包含 Python instrumentation overhead。', '',
           '| 場景 | 舊 VM | 新 VM | 舊/新 statements | 舊/新 median ms | 新首批刪 parents/versions/reports/receipts/actions | recovery batches |',
           '|---|---:|---:|---:|---:|---|---:|']
    for name,result in output['scenarios'].items():
        old,new=result['old'],result['new']; o,n=old['runs'][0],new['runs'][0]
        deletes='/'.join(str(n['logical_deletes'][t]) for t in TABLES)
        lines.append(f"| {name} | {o['vm_instructions']} | {n['vm_instructions']} | {o['statements']}/{n['statements']} | {old['median_duration_ms']:.3f}/{new['median_duration_ms']:.3f} | {deletes} | {result['recovery']['batches_including_terminal_probe']} |")
    lines += ['', '新 SQL 直接從 retention.ts 擷取並展開固定 template；舊 SQL 由 git show baseline 擷取。schema 保留來源 migrations 中相關原始 table/index/FK。fixture 先 seed，再套 0030，counter 精確等於 seed count。10005 僅代表 legacy migration，不代表新 runtime 允許超 cap。', '',
              '每次 invoke 包含 prune 與 DB 部分 schedule；不含 DO alarm API、WebSocket、auth、network 或實際 D1。commit/rollback 不列為應用 SQL statements。新首批上限 10 parents、每種關聯 child 100、standalone expired versions100，counter更新另1 row；versions 可能合計200（關聯100加獨立過期100）。', '',
              'pending每批最多10 insert、parent cascade最多10 pending delete，加counter一row；加總 logical change budget最多531，SQLite index B-tree維護與真實D1 billing未知。metadata floor清除與counter使用同一row更新。', '',
              'recovery 對有 parent 候選的 batch 在 parent delete 前注入失敗、rollback，以完整五張資料表加state/pending fingerprint驗證資料不變；沒有parent時failure_injected=false，沒有聲稱測過失敗。再成功執行並逐批 backup/reopen 新 SQLite connection，直至穩定，JSON分列失敗與rebuild耗時。這只證明 SQL 層回復，不等同 DO eviction/end-to-end 驗證。完整 query plans、各 statements、logical deletes、migration成本在 JSON。']
    (args.out/'chat-retention-benchmark.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({'json':str(args.out/'chat-retention-benchmark.json'),'markdown':str(args.out/'chat-retention-benchmark.md'),'scenarios':len(scenarios)}))


if __name__ == '__main__':
    main()
