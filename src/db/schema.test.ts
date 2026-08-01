import { describe, it, expect } from 'vitest';
import { sessions, messages, messageChunks } from './schema';

describe('schema', () => {
  it('sessions 有 summary 字段', () => {
    expect(sessions.summary).toBeDefined();
    expect(sessions.summaryTokens).toBeDefined();
  });
  it('有 message_chunks 表', () => {
    expect(messageChunks).toBeDefined();
    expect(messageChunks.sessionId).toBeDefined();
    expect(messageChunks.embedding).toBeDefined();
    expect(messageChunks.content).toBeDefined();
  });
});
