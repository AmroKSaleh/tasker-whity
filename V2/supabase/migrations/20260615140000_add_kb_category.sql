-- TDE-269 (TDE-261 Phase 2): optional KB category — a SOFT hint for the title-scan,
-- never a hard filter. Controlled vocabulary (fixed list), nullable.
alter table project_knowledge
  add column if not exists category text default null
    check (category is null or category in (
      'architecture','database','deployment','mcp','flows','design','product','gtm','reference','other'
    ));
