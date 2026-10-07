/**
 * Supabase-backed stores. This is the ONLY file that imports `@supabase/supabase-js`
 * (isolation rule, SPEC §3). It assumes the schema in
 * supabase/migrations/20260705000000_agent_core.sql already exists — it NEVER runs DDL.
 * `query()` calls the `ddj_match_chunks` RPC (the RRF fusion lives in SQL).
 *
 * Note: almost none of this runs offline. test/supabase-store.test.ts checks the write
 * order of `upsertDocument` and the error handling of `appendMessage` against a recording
 * fetch stub; nothing here has run against a real project. It typechecks and follows
 * supabase-js conventions; live behaviour has to be validated against a real project
 * (README, "What the offline suite does not cover").
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Conversation,
  ConversationStore,
  EmbeddedChunk,
  IngestedDoc,
  RetrievedChunk,
  StoredMessage,
  VectorStore,
  VisitorInfo,
} from './types.js';
import type { AgentEvent, EventSink } from '../engine/events.js';

/**
 * Stored in `content_hash` while a document's chunks are being replaced. It never equals a
 * real SHA-256 digest, so an ingest that died part-way is run again instead of skipped.
 */
const PENDING_PREFIX = 'pending:';

/** pgvector wants a bracketed literal, not a JSON array. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

class SupabaseVectorStore implements VectorStore {
  constructor(private readonly client: SupabaseClient) {}

  async getDocumentHash(sourceId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('agent_documents')
      .select('content_hash')
      .eq('source_id', sourceId)
      .maybeSingle();
    if (error) throw new Error(`getDocumentHash failed: ${error.message}`);
    return (data?.content_hash as string | undefined) ?? null;
  }

  async upsertDocument(doc: IngestedDoc, chunks: EmbeddedChunk[]): Promise<void> {
    // The real content hash is the LAST write. ingestDocuments() skips a document whose
    // stored hash matches, so recording the hash before the chunks would turn a failed chunk
    // insert into a document with no chunks that is never ingested again.
    const { data: upserted, error: docErr } = await this.client
      .from('agent_documents')
      .upsert(
        {
          source_id: doc.sourceId,
          title: doc.title,
          url: doc.url ?? null,
          content_hash: `${PENDING_PREFIX}${doc.contentHash}`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'source_id' },
      )
      .select('id')
      .single();
    if (docErr) throw new Error(`upsertDocument (document) failed: ${docErr.message}`);
    const documentId = upserted.id as string;

    // Replace-all: drop existing chunks, then insert the new set.
    const { error: delErr } = await this.client
      .from('agent_chunks')
      .delete()
      .eq('document_id', documentId);
    if (delErr) throw new Error(`upsertDocument (clear chunks) failed: ${delErr.message}`);

    if (chunks.length > 0) {
      const rows = chunks.map((c) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        embedding: toVectorLiteral(c.embedding),
        metadata: c.metadata ?? {},
      }));
      const { error: insErr } = await this.client.from('agent_chunks').insert(rows);
      if (insErr) throw new Error(`upsertDocument (insert chunks) failed: ${insErr.message}`);
    }

    const { error: hashErr } = await this.client
      .from('agent_documents')
      .update({ content_hash: doc.contentHash, updated_at: new Date().toISOString() })
      .eq('id', documentId);
    if (hashErr) throw new Error(`upsertDocument (record hash) failed: ${hashErr.message}`);
  }

  async query(q: { embedding: number[]; text: string; limit: number }): Promise<RetrievedChunk[]> {
    const { data, error } = await this.client.rpc('ddj_match_chunks', {
      query_embedding: toVectorLiteral(q.embedding),
      query_text: q.text,
      match_count: q.limit,
    });
    if (error) throw new Error(`match_chunks RPC failed: ${error.message}`);
    const rows = (data ?? []) as Array<{
      id: string;
      content: string;
      source_id: string;
      title: string;
      url: string | null;
      rrf_score: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      sourceId: r.source_id,
      title: r.title,
      url: r.url ?? undefined,
      score: r.rrf_score,
    }));
  }
}

class SupabaseConversationStore implements ConversationStore {
  constructor(private readonly client: SupabaseClient) {}

  async create(meta: { visitor?: VisitorInfo; page?: string }): Promise<Conversation> {
    const { data, error } = await this.client
      .from('agent_conversations')
      .insert({ visitor: meta.visitor ?? null, page: meta.page ?? null })
      .select('*')
      .single();
    if (error) throw new Error(`conversation create failed: ${error.message}`);
    return rowToConversation(data);
  }

  async get(id: string): Promise<Conversation | null> {
    const { data, error } = await this.client
      .from('agent_conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`conversation get failed: ${error.message}`);
    return data ? rowToConversation(data) : null;
  }

  async appendMessage(id: string, msg: StoredMessage): Promise<void> {
    const { error } = await this.client
      .from('agent_messages')
      .insert({ conversation_id: id, role: msg.role, content: msg.content });
    if (error) throw new Error(`appendMessage failed: ${error.message}`);
    const { error: touchErr } = await this.client
      .from('agent_conversations')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', id);
    if (touchErr) throw new Error(`appendMessage (touch conversation) failed: ${touchErr.message}`);
  }

  async listMessages(id: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.client
      .from('agent_messages')
      .select('role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listMessages failed: ${error.message}`);
    const rows = (data ?? []) as Array<{
      role: 'user' | 'assistant';
      content: string;
      created_at: string;
    }>;
    // Fetched newest-first for the limit; return ascending.
    return rows
      .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }))
      .reverse();
  }

  async setStatus(id: string, status: Conversation['status']): Promise<void> {
    const { error } = await this.client.from('agent_conversations').update({ status }).eq('id', id);
    if (error) throw new Error(`setStatus failed: ${error.message}`);
  }
}

class SupabaseEventSink implements EventSink {
  constructor(private readonly client: SupabaseClient) {}

  async write(e: AgentEvent): Promise<void> {
    const { error } = await this.client.from('agent_events').insert({
      conversation_id: e.conversationId || null,
      type: e.type,
      payload: e.payload,
    });
    if (error) throw new Error(`event write failed: ${error.message}`);
  }
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    status: (row.status as Conversation['status']) ?? 'open',
    visitor: (row.visitor as VisitorInfo | null) ?? undefined,
    page: (row.page as string | null) ?? undefined,
    createdAt: String(row.created_at),
    lastActiveAt: String(row.last_active_at ?? row.created_at),
  };
}

export function createSupabaseStores(
  url: string,
  serviceKey: string,
): { vectorStore: VectorStore; conversations: ConversationStore; events: EventSink } {
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    vectorStore: new SupabaseVectorStore(client),
    conversations: new SupabaseConversationStore(client),
    events: new SupabaseEventSink(client),
  };
}
