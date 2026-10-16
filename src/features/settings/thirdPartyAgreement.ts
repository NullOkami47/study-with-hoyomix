import type { Locale } from '../../i18n'
export * from '../player/thirdPartyConsent'
const transportDisclosure = {
  'zh-Hant': '目前整合以 HTTPS GET 呼叫 api.chksz.com，金鑰放在 URL 的 apikey 查詢參數；瀏覽器開發者工具 Network 面板可看見，ChKSz 及其處理請求的基礎設施也可能將完整 URL 寫入日誌。HTTPS 會加密傳輸，無法對接收方隱藏 URL。直接解析的 no-store 與 no-referrer 限制快取及來源網址傳送，無法隱藏金鑰或控制第三方日誌。動態搜尋先以 x-chksz-api-key 標頭把金鑰傳至本站代理，再由代理以 apikey 查詢參數呼叫 ChKSz；找到歌曲後仍直接解析。',
  'zh-Hans': '当前集成以 HTTPS GET 调用 api.chksz.com，密钥位于 URL 的 apikey 查询参数；浏览器开发者工具 Network 面板可见，ChKSz 及处理请求的基础设施也可能将完整 URL 记入日志。HTTPS 加密传输，无法对接收方隐藏 URL。直接解析的 no-store 与 no-referrer 限制缓存及来源网址发送，无法隐藏密钥或控制第三方日志。动态搜索先通过 x-chksz-api-key 请求头将密钥发送至本站代理，再由代理以 apikey 查询参数调用 ChKSz；找到歌曲后仍直接解析。',
  en: 'The current integration calls api.chksz.com using HTTPS GET with the key in the URL’s apikey query parameter. It is visible in your browser’s DevTools Network panel; ChKSz and infrastructure handling its requests may also log the full URL. HTTPS encrypts transport but does not hide the URL from the recipient. Direct resolution uses no-store and no-referrer to limit caching and referrer transmission; these do not conceal the key or control third-party logs. Dynamic discovery first sends the key to this site’s proxy in the x-chksz-api-key header; the proxy then calls ChKSz with an apikey query parameter. The discovered track is still resolved directly.',
} satisfies Record<Locale, string>
export const agreementCopy = {
  'zh-Hant': {
    title: '第三方音樂源使用協議', read: '閱讀第三方音樂源使用協議', check: '我已閱讀並同意本版本協議', accept: '同意並繼續', cancel: '取消', withdraw: '撤回同意並停用自訂來源', accepted: '已同意目前版本', info: 'ChKSz API Key 說明', close: '關閉說明',
    infoIntro: '使用 api.chksz.com 提供的網易雲音樂、QQ 音樂及酷狗音樂解析介面。請先前往網站註冊並登入，取得個人 API Key。目前的註冊資格以 ChKSz 官方網站公布的資訊為準，可能僅支援 LinuxDo 使用者。',
    infoPrivacy: '個人 API Key 預設只保留在目前頁面的記憶體，重新載入頁面即會清除；選擇記住時，會儲存在此裝置的瀏覽器儲存空間。解析已有來源的歌曲時會直接傳送至 ChKSz；動態搜尋歌曲時會透過本站必要的代理端點傳送至 ChKSz。個人 Key 不會同步到 Study with HOYO-MiX 帳戶。',
    paragraphs: [
      '本協議適用於你主動設定的個人 ChKSz API Key 及自訂 LX 音樂源。本站提供配置與呼叫功能；第三方服務獨立營運，其名稱、內容與帳戶不代表本站與該服務、音樂平台或權利人有合作或授權關係。本站既有 Jellyfin、catalogue 與基本播放不以同意本協議為前提。',
      '請確認你有權使用接口、帳戶及內容，並遵守所在地適用法律、版權要求、第三方服務條款與隱私政策。不得以這些功能規避付費、地區限制、版權保護或存取控制；請自行評估來源可信度，勿提供不必要的密碼、Cookie 或其他敏感資料。',
      'API Key、歌曲識別碼、查詢內容及播放請求可能直接或經本站必要代理傳送至第三方；第三方亦會取得建立網絡連線所需的資料。個人 ChKSz Key 預設只留在頁面記憶體，記住時存於本機瀏覽器，不同步至本站帳戶。靜態來源解析直接向 ChKSz 發送 Key，動態搜尋則經本站代理。自訂 LX 腳本存於本機 IndexedDB，其網絡請求依沙箱及本站安全政策執行。',
      '第三方的服務可能中斷、變更、收費或回傳錯誤、不安全或侵權內容。本站無法保證其可用性、準確性、安全性或隱私做法；請閱讀其政策並自行決定是否使用。個人 Key、自訂腳本與同意記錄只保留在目前裝置，同意不代表本站替第三方作出保證。',
      '你可在播放設定清除個人 Key、停用或刪除自訂 LX 來源，或選擇撤回同意。撤回會清除本機個人 Key 並停用自訂 LX 來源；內建來源不受影響。已開始的播放可能繼續，請暫停播放以停止傳輸。第三方已保存的資料不會自動刪除，需依其流程處理。版本變更後，已納入本流程的自訂來源需重新同意才會用於新的解析請求。',
      '在適用法律允許範圍內，本站對無法合理控制的第三方服務故障或內容不承擔保證責任。此限制不排除或減少法律不得限制的責任、消費者權利，或本站依法應承擔的責任。第三方爭議可先聯絡服務提供者；本協議不妨礙你依法尋求救濟。',
    ],
  },
  'zh-Hans': {
    title: '第三方音乐源使用协议', read: '阅读第三方音乐源使用协议', check: '我已阅读并同意本版本协议', accept: '同意并继续', cancel: '取消', withdraw: '撤回同意并停用自定义来源', accepted: '已同意当前版本', info: 'ChKSz API Key 说明', close: '关闭说明',
    infoIntro: '使用 api.chksz.com 提供的网易云音乐、QQ 音乐及酷狗音乐解析接口。请先前往网站注册并登录，取得个人 API Key。目前的注册资格以 ChKSz 官方网站公布的信息为准，可能仅支持 LinuxDo 用户。',
    infoPrivacy: '个人 API Key 默认只保留在当前页面的内存，重新加载页面即会清除；选择记住时，会保存在此设备的浏览器存储空间。解析已有来源的歌曲时会直接发送至 ChKSz；动态搜索歌曲时会经本站必要的代理端点发送至 ChKSz。个人 Key 不会同步到 Study with HOYO-MiX 账户。',
    paragraphs: [
      '本协议适用于你主动设置的个人 ChKSz API Key 及自定义 LX 音乐源。本站提供配置与调用功能；第三方服务独立运营，其名称、内容及账户不表示本站与该服务、音乐平台或权利人有合作或授权关系。既有 Jellyfin、catalogue 及基本播放不要求同意本协议。',
      '请确认你有权使用接口、账户及内容，遵守适用法律、版权要求、第三方服务条款与隐私政策。不得规避付费、地区限制、版权保护或访问控制。请判断来源可信度，勿提供不必要的密码、Cookie 等敏感信息。',
      'API Key、歌曲标识、查询内容及播放请求可能直接或经本站代理发送至第三方，第三方也会取得建立网络连接所需的数据。个人 Key 默认留在页面内存，记住时存于本机浏览器，不同步至本站账户。静态解析直接向 ChKSz 发送 Key，动态搜索经本站代理。自定义 LX 脚本存于本机 IndexedDB，其网络请求受沙箱及本站安全政策限制。',
      '第三方服务可能中断、变更、收费或返回错误、不安全或侵权内容。本站无法保证其可用性、准确性、安全性或隐私做法。请阅读其政策自行决定是否使用。同意记录只保留在当前设备，不代表本站为第三方作出保证。',
      '可在播放设置清除个人 Key、停用或删除自定义 LX 来源，或撤回同意。撤回将清除本机个人 Key 并停用自定义 LX，内建来源不受影响。已开始的播放可能继续，请暂停以停止传输。第三方已保存的数据不会自动删除，需依其流程处理。版本变更后，已纳入此流程的来源须重新同意才能进行新的解析请求。',
      '在适用法律允许范围内，本站对无法合理控制的第三方故障或内容不承担保证责任。本限制不排除法律不得限制的责任、消费者权利或本站依法应承担的责任。可联系第三方处理争议，此协议不妨碍依法寻求救济。',
    ],
  },
  en: {
    title: 'Third-party music source agreement', read: 'Read the third-party music source agreement', check: 'I have read and agree to this version', accept: 'Agree and continue', cancel: 'Cancel', withdraw: 'Withdraw consent and disable custom sources', accepted: 'Current version accepted', info: 'ChKSz API Key information', close: 'Close information',
    infoIntro: 'Uses the NetEase Cloud Music, QQ Music and Kugou resolution interfaces provided by api.chksz.com. Register and sign in there to obtain your personal API Key. Registration eligibility follows the current ChKSz website and may be limited to LinuxDo users.',
    infoPrivacy: 'Your personal API Key stays in page memory by default and is cleared on reload. Choosing remember stores it in this device’s browser storage. Existing track sources are resolved directly with ChKSz; dynamic discovery sends it through this site’s necessary proxy endpoint. Your personal Key is not synchronised to your Study with HOYO-MiX account.',
    paragraphs: [
      'This agreement covers personal ChKSz API Keys and custom LX sources you deliberately configure. This site provides configuration and request facilities. Third parties operate independently; their names, content and accounts do not imply partnership or authorisation by this site, music platforms or rights holders. Existing Jellyfin, catalogue and basic playback do not require acceptance.',
      'Ensure you are entitled to use the interfaces, accounts and content. Follow applicable law, copyright, third-party terms and privacy policies. Do not circumvent payment, regional restrictions, copyright protection or access controls. Assess each source and avoid unnecessary passwords, cookies or other sensitive information.',
      'API Keys, track identifiers, queries and playback requests may reach third parties directly or through this site’s necessary proxy. Third parties also receive connection data. Personal ChKSz Keys stay in page memory by default, or local browser storage when remembered, and are not synchronised to your account. Static resolution sends the Key directly to ChKSz; dynamic discovery uses this site’s proxy. Custom LX scripts reside in local IndexedDB and their network requests follow the sandbox and site security policy.',
      'Third-party services may fail, change, charge fees or return inaccurate, unsafe or infringing content. This site cannot guarantee their availability, accuracy, security or privacy practices. Read their policies and decide whether to use them. Consent receipts stay on this device and do not constitute a guarantee of a third party.',
      'Clear your personal Key, disable or delete custom LX sources in Playback settings, or withdraw consent. Withdrawal clears the local personal Key and disables custom LX sources; built-in sources remain available. Playback already started may continue: pause to stop transmission. Data already held by third parties is not automatically deleted; follow their procedures. Following a version change, sources enrolled in this flow require renewed consent before new resolution requests.',
      'To the extent permitted by applicable law, this site gives no warranty for third-party failures or content beyond its reasonable control. This does not exclude non-excludable liability, consumer rights or responsibility imposed on this site by law. Contact the service provider about disputes; this agreement does not prevent lawful remedies.',
    ],
  },
} satisfies Record<Locale, { title: string; read: string; check: string; accept: string; cancel: string; withdraw: string; accepted: string; info: string; close: string; infoIntro: string; infoPrivacy: string; paragraphs: string[] }>

// The help and pre-acceptance agreement show the same transport boundary in every locale.
for (const locale of Object.keys(transportDisclosure) as Locale[]) {
  agreementCopy[locale].infoPrivacy += ` ${transportDisclosure[locale]}`
  agreementCopy[locale].paragraphs.splice(3, 0, transportDisclosure[locale])
}
