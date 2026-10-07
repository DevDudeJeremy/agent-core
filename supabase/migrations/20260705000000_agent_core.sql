-- agent-core persistence schema.
--
-- FILE ONLY. Nothing in this repository ever applies this migration. Apply it to the
-- Supabase project the agent will use, via the Supabase CLI or dashboard (README,
-- "Applying the migration"). The agent server connects with the SERVICE-ROLE key, so RLS is
-- enabled on every table with NO policies — there is no anon/authenticated access path.
--
-- Embedding dimension is 1024 and MUST match `EMBEDDING_DIM` in src/rag/embed.ts. If you
-- change one, change both (and re-embed all content).

create extension if not exists vector;

-- ── Documents ────────────────────────────────────────────────────────────────
create table if not exists agent_documents (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null unique,
  title        text not null,
  url          text,
  content_hash text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Chunks ───────────────────────────────────────────────────────────────────
create table if not exists agent_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references agent_documents (id) on delete cascade,
  chunk_index int not null,
  content     text not null,
  embedding   vector(1024) not null,
  fts         tsvector generated always as (to_tsvector('english', content)) stored,
  metadata    jsonb not null default '{}'::jsonb
);

create index if not exists agent_chunks_embedding_idx
  on agent_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists agent_chunks_fts_idx
  on agent_chunks using gin (fts);
create index if not exists agent_chunks_document_idx
  on agent_chunks (document_id);

-- ── Conversations ────────────────────────────────────────────────────────────
create table if not exists agent_conversations (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'open' check (status in ('open', 'handed_off', 'closed')),
  visitor        jsonb,
  page           text,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

-- ── Messages ─────────────────────────────────────────────────────────────────
create table if not exists agent_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agent_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  created_at      timestamptz not null default now()
);

create index if not exists agent_messages_conversation_idx
  on agent_messages (conversation_id, created_at);

-- ── Events (observability / human-in-the-loop record) ────────────────────────
create table if not exists agent_events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid,
  type            text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists agent_events_type_idx
  on agent_events (type, created_at);

-- ── RLS: enabled everywhere, NO policies. Service-role access only. ───────────
alter table agent_documents     enable row level security;
alter table agent_chunks        enable row level security;
alter table agent_conversations enable row level security;
alter table agent_messages      enable row level security;
alter table agent_events        enable row level security;

-- ── Hybrid retrieval: vector + full-text, fused with Reciprocal Rank Fusion ───
-- Top 12 by cosine distance + top 12 by ts_rank over websearch_to_tsquery,
-- full-outer-joined and fused with RRF at k = 60. Returns match_count rows.
create or replace function ddj_match_chunks(
  query_embedding vector(1024),
  query_text      text,
  match_count     int
)
returns table (
  id        uuid,
  content   text,
  source_id text,
  title     text,
  url       text,
  rrf_score double precision
)
language sql
stable
as $$
  with vector_hits as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from agent_chunks c
    order by c.embedding <=> query_embedding
    limit 12
  ),
  fts_hits as (
    select c.id,
           row_number() over (
             order by ts_rank(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from agent_chunks c
    where c.fts @@ websearch_to_tsquery('english', query_text)
    order by ts_rank(c.fts, websearch_to_tsquery('english', query_text)) desc
    limit 12
  ),
  fused as (
    select
      coalesce(v.id, f.id) as id,
      coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + f.rank), 0.0) as rrf_score
    from vector_hits v
    full outer join fts_hits f on v.id = f.id
  )
  select c.id, c.content, d.source_id, d.title, d.url, fused.rrf_score
  from fused
  join agent_chunks c on c.id = fused.id
  join agent_documents d on d.id = c.document_id
  order by fused.rrf_score desc
  limit match_count;
$$;
