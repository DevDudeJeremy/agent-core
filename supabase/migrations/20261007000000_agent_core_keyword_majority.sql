-- agent-core: the keyword half of retrieval (version 0.2.0).
--
-- FILE ONLY, like the first migration. Nothing in this repository applies it. Apply every
-- file in this folder, in name order, to the Supabase project the agent will use.
--
-- This file holds one statement. It replaces ddj_match_chunks, which the first migration
-- (20260705000000_agent_core.sql) defines. That file is frozen as published and its
-- definition is superseded by this one. No table, column or index changes, and nothing has
-- to be ingested again.
--
-- What changes is the keyword half. The vector half, the fusion and the columns returned
-- are as in the first file: top 12 by cosine distance, top 12 by keyword, full outer join,
-- Reciprocal Rank Fusion at k = 60, equal weights, match_count rows.
--
-- The rule. The message is read as plain words. Stop words are dropped and the rest are
-- stemmed, by the same 'english' configuration that builds the fts column. A passage gets a
-- keyword vote only when it holds MORE THAN HALF of the message's distinct words. Passages
-- that qualify are ordered by how many of the words they hold, then by ts_rank, then by
-- document (source_id in byte order) and chunk, and the first 12 go into the fusion.
--
-- Why that strict. With k = 60 and 12 candidates a side, a passage in both lists scores at
-- least 1/72 + 1/72 = 0.0278 and a passage in one list at most 1/61 = 0.0164. So a passage
-- in both lists outranks every passage in one, whatever the ranks, and what the keyword
-- half lets in matters more than how it orders it.
--
-- What the keyword half reads of a message is bounded twice, before anything parses it:
--   1. the first ten thousand characters, and no more;
--   2. within those, nothing in an unbroken run of one hundred characters or more. A run
--      is broken by a space, a tab, a line feed or a carriage return, and by nothing else.
--      A pasted address, key or blob of that length is skipped, not searched.
-- The second bound is there because Postgres limits a word in bytes (2,046), measured
-- after the word is folded to lower case, and what a server does with a longer word
-- depends on its version: drop it, raise, or keep a broken copy. A word of 99 characters
-- is at most 1,188 bytes after any folding, so no word of a message comes near the limit.
-- The vector half is not affected: the embedding is made from the whole message.
--
-- Nothing a visitor types is search syntax. The message is read once, by the expression
-- named "read" below. to_tsvector() and plainto_tsquery() read its result, and neither
-- recognises an operator. The only text cast to tsquery is Postgres's own rendering of a
-- query it built.
--
-- A stored passage is not bounded by this file: the fts column is built by the first
-- migration. The count below reads a passage through strip(), so that a passage whose
-- words a server indexed wrongly is read for its words and never rebuilt with its
-- positions.
--
-- Going back: run the first migration file again. Its function is create-or-replace too,
-- and that restores the every-word keyword half of 0.1.x, which has neither bound: on
-- some Postgres versions a message can make it raise (README, "Applying the migrations").

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
  message as (
    select regexp_replace(
             left(query_text, 10000), '[^ \t\n\r]{100}[^ \t\n\r]*', ' ', 'g'
           ) as read
  ),
  asked as (
    select
      tsvector_to_array(to_tsvector('english', m.read)) as words,
      replace(plainto_tsquery('english', m.read)::text, ' & ', ' | ')::tsquery as any_word
    from message m
  ),
  candidates as (
    select c.id, c.fts, c.chunk_index, d.source_id, a.any_word,
           length(c.fts) - length(ts_delete(strip(c.fts), a.words)) as words_held,
           cardinality(a.words) as words_asked
    from agent_chunks c
    join agent_documents d on d.id = c.document_id
    cross join asked a
    where c.fts @@ a.any_word
  ),
  fts_hits as (
    select k.id,
           row_number() over (
             order by k.words_held desc, ts_rank(k.fts, k.any_word) desc,
                      k.source_id collate "C" asc, k.chunk_index asc
           ) as rank
    from candidates k
    where 2 * k.words_held > k.words_asked
    order by k.words_held desc, ts_rank(k.fts, k.any_word) desc,
             k.source_id collate "C" asc, k.chunk_index asc
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
