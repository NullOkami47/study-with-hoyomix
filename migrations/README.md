# D1 migrations

Wrangler applies the `NNNN_name.sql` files in this directory in lexical filename order and
records each applied filename in `d1_migrations`. Applied migrations are never renamed,
removed or rewritten (a rename would make Wrangler replay the file under its new name).

## The two `0023_` migrations

Two migrations share the `0023_` prefix:

1. `0023_background_video_duration_ms.sql` rebuilds `background_media_revisions` to relax the
   video duration bound.
2. `0023_focus_classification_independent.sql` rebuilds `catalogue_tracks` with an explicit
   focus classification.

Lexical order puts `0023_background_video_duration_ms.sql` first. The two files touch
unrelated tables, so either order gives the same schema. Both are already applied in every
environment, so they keep their names.

## No new duplicate prefixes

Do not introduce duplicate four-digit migration prefixes beyond the legacy `0023_` pair above. Give each new migration the next unused number in `NNNN_name.sql` format.
