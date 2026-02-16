import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CommentService } from './comments.js';
import { PathFilter } from './pathfilter.js';
describe('CommentService', () => {
    let vaultPath;
    let service;
    let pathFilter;
    beforeEach(async () => {
        vaultPath = await mkdtemp(join(tmpdir(), 'mcp-comments-test-'));
        pathFilter = new PathFilter({ sidecarPatterns: ['.comments.json'] });
        service = new CommentService(vaultPath, pathFilter, 'test-author', '1.0.0');
        // Create a test note
        await writeFile(join(vaultPath, 'note.md'), '# Title\n\nLine 3 content\nLine 4 content\nLine 5 content\n');
    });
    afterEach(async () => {
        try {
            await rm(vaultPath, { recursive: true });
        }
        catch {
            // Ignore cleanup errors
        }
    });
    // ============================================================================
    // READ COMMENTS
    // ============================================================================
    describe('readComments', () => {
        it('returns empty result when no sidecar exists', async () => {
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments).toEqual([]);
            expect(result.metadata.total_comments).toBe(0);
            expect(result.note_path).toBe('note.md');
        });
        it('reads comments from existing sidecar', async () => {
            // Add a comment first
            await service.addComment({
                path: 'note.md',
                content: 'Test comment',
                startLine: 3,
                endLine: 3,
            });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments).toHaveLength(1);
            expect(result.comments[0].content).toBe('Test comment');
            expect(result.comments[0].author).toBe('test-author');
            expect(result.metadata.total_comments).toBe(1);
            expect(result.metadata.open_count).toBe(1);
        });
        it('filters by status', async () => {
            await service.addComment({ path: 'note.md', content: 'Open comment', startLine: 3, endLine: 3 });
            const addResult = await service.addComment({ path: 'note.md', content: 'Resolved comment', startLine: 4, endLine: 4 });
            await service.resolveComment({ path: 'note.md', commentId: addResult.commentId });
            const openOnly = await service.readComments({ path: 'note.md', status: 'open' });
            expect(openOnly.comments).toHaveLength(1);
            expect(openOnly.comments[0].content).toBe('Open comment');
            const resolvedOnly = await service.readComments({ path: 'note.md', status: 'resolved' });
            expect(resolvedOnly.comments).toHaveLength(1);
            expect(resolvedOnly.comments[0].content).toBe('Resolved comment');
        });
        it('filters by author', async () => {
            await service.addComment({ path: 'note.md', content: 'My comment', startLine: 3, endLine: 3 });
            const result = await service.readComments({ path: 'note.md', author: 'test-author' });
            expect(result.comments).toHaveLength(1);
            const noMatch = await service.readComments({ path: 'note.md', author: 'other' });
            expect(noMatch.comments).toHaveLength(0);
        });
        it('throws on malformed JSON sidecar', async () => {
            await writeFile(join(vaultPath, 'note.md.comments.json'), 'not valid json');
            await expect(service.readComments({ path: 'note.md' })).rejects.toThrow('Failed to parse comments file');
        });
        it('throws on unsupported schema version', async () => {
            const future = {
                version: 999,
                createdBy: 'future',
                note_path: 'note.md',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                comments: [],
                metadata: { total_comments: 0, open_count: 0, resolved_count: 0, authors: [] },
            };
            await writeFile(join(vaultPath, 'note.md.comments.json'), JSON.stringify(future));
            await expect(service.readComments({ path: 'note.md' })).rejects.toThrow('Unsupported comment format version');
        });
        it('throws on restricted path', async () => {
            await expect(service.readComments({ path: '.obsidian/config.json' })).rejects.toThrow('Access denied');
        });
    });
    // ============================================================================
    // ADD COMMENT
    // ============================================================================
    describe('addComment', () => {
        it('creates sidecar when none exists', async () => {
            const result = await service.addComment({
                path: 'note.md',
                content: 'First comment',
                startLine: 1,
                endLine: 1,
            });
            expect(result.success).toBe(true);
            expect(result.commentId).toMatch(/^c_/);
            expect(result.path).toBe('note.md');
            // Verify sidecar was created
            const sidecarContent = await readFile(join(vaultPath, 'note.md.comments.json'), 'utf-8');
            const parsed = JSON.parse(sidecarContent);
            expect(parsed.version).toBe(1);
            expect(parsed.createdBy).toBe('mcp-obsidian@1.0.0');
            expect(parsed.note_path).toBe('note.md');
            expect(parsed.comments).toHaveLength(1);
        });
        it('appends to existing sidecar', async () => {
            await service.addComment({ path: 'note.md', content: 'First', startLine: 1, endLine: 1 });
            await service.addComment({ path: 'note.md', content: 'Second', startLine: 3, endLine: 3 });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments).toHaveLength(2);
            expect(result.metadata.total_comments).toBe(2);
        });
        it('captures content snippet from target line', async () => {
            await service.addComment({ path: 'note.md', content: 'Comment on line 3', startLine: 3, endLine: 3 });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments[0].content_snippet).toBe('Line 3 content');
        });
        it('sets location correctly', async () => {
            await service.addComment({
                path: 'note.md',
                content: 'Range comment',
                startLine: 3,
                endLine: 5,
                startChar: 2,
                endChar: 10,
            });
            const result = await service.readComments({ path: 'note.md' });
            const location = result.comments[0].location;
            expect(location.type).toBe('range');
            expect(location.start_line).toBe(3);
            expect(location.start_char).toBe(2);
            expect(location.end_line).toBe(5);
            expect(location.end_char).toBe(10);
        });
        it('defaults startChar and endChar to 0', async () => {
            await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments[0].location.start_char).toBe(0);
            expect(result.comments[0].location.end_char).toBe(0);
        });
        it('throws when note does not exist', async () => {
            await expect(service.addComment({ path: 'nonexistent.md', content: 'Comment', startLine: 1, endLine: 1 })).rejects.toThrow('Note not found: nonexistent.md');
        });
        it('throws when startLine is out of bounds', async () => {
            await expect(service.addComment({ path: 'note.md', content: 'Comment', startLine: 0, endLine: 1 })).rejects.toThrow('Invalid location: startLine 0 is out of range');
        });
        it('throws when startLine exceeds line count', async () => {
            await expect(service.addComment({ path: 'note.md', content: 'Comment', startLine: 100, endLine: 100 })).rejects.toThrow('Invalid location: startLine 100 is out of range');
        });
        it('throws when endLine is before startLine', async () => {
            await expect(service.addComment({ path: 'note.md', content: 'Comment', startLine: 3, endLine: 2 })).rejects.toThrow('Invalid location: endLine 2 is out of range');
        });
        it('sets timestamps correctly', async () => {
            const before = new Date().toISOString();
            await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            const after = new Date().toISOString();
            const result = await service.readComments({ path: 'note.md' });
            const comment = result.comments[0];
            expect(comment.created_at >= before).toBe(true);
            expect(comment.created_at <= after).toBe(true);
            expect(comment.last_activity_at).toBe(comment.created_at);
        });
        it('updates metadata after adding', async () => {
            await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.metadata.total_comments).toBe(1);
            expect(result.metadata.open_count).toBe(1);
            expect(result.metadata.resolved_count).toBe(0);
            expect(result.metadata.authors).toEqual(['test-author']);
        });
        it('generates unique IDs', async () => {
            await service.addComment({ path: 'note.md', content: 'First', startLine: 1, endLine: 1 });
            await service.addComment({ path: 'note.md', content: 'Second', startLine: 2, endLine: 2 });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments[0].id).not.toBe(result.comments[1].id);
        });
        it('creates sidecar in subdirectory', async () => {
            await mkdir(join(vaultPath, 'subdir'), { recursive: true });
            await writeFile(join(vaultPath, 'subdir', 'deep.md'), '# Deep note\nContent\n');
            const result = await service.addComment({
                path: 'subdir/deep.md',
                content: 'Deep comment',
                startLine: 1,
                endLine: 1,
            });
            expect(result.success).toBe(true);
            const sidecar = await readFile(join(vaultPath, 'subdir', 'deep.md.comments.json'), 'utf-8');
            expect(JSON.parse(sidecar)).toBeDefined();
        });
    });
    // ============================================================================
    // REPLY TO COMMENT
    // ============================================================================
    describe('replyToComment', () => {
        it('appends reply to comment thread', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Original', startLine: 1, endLine: 1 });
            const replyResult = await service.replyToComment({
                path: 'note.md',
                commentId: addResult.commentId,
                content: 'My reply',
            });
            expect(replyResult.success).toBe(true);
            expect(replyResult.replyId).toMatch(/^c_/);
            expect(replyResult.commentId).toBe(addResult.commentId);
            expect(replyResult.reopened).toBe(false);
            const comments = await service.readComments({ path: 'note.md' });
            expect(comments.comments[0].replies).toHaveLength(1);
            expect(comments.comments[0].replies[0].content).toBe('My reply');
            expect(comments.comments[0].replies[0].author).toBe('test-author');
        });
        it('reopens resolved comment on reply', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Original', startLine: 1, endLine: 1 });
            await service.resolveComment({ path: 'note.md', commentId: addResult.commentId });
            const replyResult = await service.replyToComment({
                path: 'note.md',
                commentId: addResult.commentId,
                content: 'Reopening reply',
            });
            expect(replyResult.reopened).toBe(true);
            const comments = await service.readComments({ path: 'note.md' });
            expect(comments.comments[0].status).toBe('open');
        });
        it('updates last_activity_at on reply', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Original', startLine: 1, endLine: 1 });
            const commentsBefore = await service.readComments({ path: 'note.md' });
            const activityBefore = commentsBefore.comments[0].last_activity_at;
            // Small delay to ensure timestamp differs
            await new Promise(resolve => setTimeout(resolve, 10));
            await service.replyToComment({
                path: 'note.md',
                commentId: addResult.commentId,
                content: 'Reply',
            });
            const commentsAfter = await service.readComments({ path: 'note.md' });
            expect(commentsAfter.comments[0].last_activity_at > activityBefore).toBe(true);
        });
        it('updates metadata authors after reply', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Original', startLine: 1, endLine: 1 });
            // Create a second service with different author
            const otherService = new CommentService(vaultPath, pathFilter, 'other-author', '1.0.0');
            await otherService.replyToComment({
                path: 'note.md',
                commentId: addResult.commentId,
                content: 'Reply from other',
            });
            const comments = await service.readComments({ path: 'note.md' });
            expect(comments.metadata.authors).toContain('test-author');
            expect(comments.metadata.authors).toContain('other-author');
        });
        it('throws when no comments file exists', async () => {
            await expect(service.replyToComment({ path: 'note.md', commentId: 'c_fake', content: 'Reply' })).rejects.toThrow('No comments found for note.md');
        });
        it('throws when comment ID not found', async () => {
            await service.addComment({ path: 'note.md', content: 'Original', startLine: 1, endLine: 1 });
            await expect(service.replyToComment({ path: 'note.md', commentId: 'c_nonexistent', content: 'Reply' })).rejects.toThrow('Comment not found: c_nonexistent');
        });
    });
    // ============================================================================
    // RESOLVE COMMENT
    // ============================================================================
    describe('resolveComment', () => {
        it('resolves an open comment', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            const resolveResult = await service.resolveComment({
                path: 'note.md',
                commentId: addResult.commentId,
            });
            expect(resolveResult.success).toBe(true);
            expect(resolveResult.status).toBe('resolved');
            const comments = await service.readComments({ path: 'note.md' });
            expect(comments.comments[0].status).toBe('resolved');
            expect(comments.metadata.open_count).toBe(0);
            expect(comments.metadata.resolved_count).toBe(1);
        });
        it('reopens a resolved comment', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            await service.resolveComment({ path: 'note.md', commentId: addResult.commentId });
            const result = await service.resolveComment({
                path: 'note.md',
                commentId: addResult.commentId,
                status: 'open',
            });
            expect(result.status).toBe('open');
            const comments = await service.readComments({ path: 'note.md' });
            expect(comments.comments[0].status).toBe('open');
        });
        it('is idempotent', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            await service.resolveComment({ path: 'note.md', commentId: addResult.commentId });
            // Resolve again — should not throw
            const result = await service.resolveComment({
                path: 'note.md',
                commentId: addResult.commentId,
            });
            expect(result.success).toBe(true);
            expect(result.status).toBe('resolved');
        });
        it('updates last_activity_at', async () => {
            const addResult = await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            const before = (await service.readComments({ path: 'note.md' })).comments[0].last_activity_at;
            await new Promise(resolve => setTimeout(resolve, 10));
            await service.resolveComment({ path: 'note.md', commentId: addResult.commentId });
            const after = (await service.readComments({ path: 'note.md' })).comments[0].last_activity_at;
            expect(after > before).toBe(true);
        });
        it('throws when comment not found', async () => {
            await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            await expect(service.resolveComment({ path: 'note.md', commentId: 'c_nonexistent' })).rejects.toThrow('Comment not found: c_nonexistent');
        });
        it('throws when no comments file exists', async () => {
            await expect(service.resolveComment({ path: 'note.md', commentId: 'c_fake' })).rejects.toThrow('No comments found for note.md');
        });
    });
    // ============================================================================
    // LIST COMMENTED NOTES
    // ============================================================================
    describe('listCommentedNotes', () => {
        it('returns empty when no sidecars exist', async () => {
            const result = await service.listCommentedNotes();
            expect(result.notes).toEqual([]);
            expect(result.summary.notesWithComments).toBe(0);
        });
        it('finds notes with comments', async () => {
            await service.addComment({ path: 'note.md', content: 'Comment', startLine: 1, endLine: 1 });
            const result = await service.listCommentedNotes();
            expect(result.notes).toHaveLength(1);
            expect(result.notes[0].path).toBe('note.md');
            expect(result.notes[0].total).toBe(1);
            expect(result.notes[0].open).toBe(1);
        });
        it('finds comments in subdirectories', async () => {
            await mkdir(join(vaultPath, 'subdir'), { recursive: true });
            await writeFile(join(vaultPath, 'subdir', 'nested.md'), '# Nested\nContent\n');
            await service.addComment({ path: 'subdir/nested.md', content: 'Deep comment', startLine: 1, endLine: 1 });
            const result = await service.listCommentedNotes();
            expect(result.notes).toHaveLength(1);
            expect(result.notes[0].path).toBe('subdir/nested.md');
        });
        it('scopes to directory when path provided', async () => {
            await mkdir(join(vaultPath, 'dir-a'), { recursive: true });
            await mkdir(join(vaultPath, 'dir-b'), { recursive: true });
            await writeFile(join(vaultPath, 'dir-a', 'a.md'), '# A\n');
            await writeFile(join(vaultPath, 'dir-b', 'b.md'), '# B\n');
            await service.addComment({ path: 'dir-a/a.md', content: 'Comment A', startLine: 1, endLine: 1 });
            await service.addComment({ path: 'dir-b/b.md', content: 'Comment B', startLine: 1, endLine: 1 });
            const result = await service.listCommentedNotes({ path: 'dir-a' });
            expect(result.notes).toHaveLength(1);
            expect(result.notes[0].path).toBe('dir-a/a.md');
        });
        it('sorts by open count descending', async () => {
            await writeFile(join(vaultPath, 'few.md'), '# Few\nLine 2\n');
            await writeFile(join(vaultPath, 'many.md'), '# Many\nLine 2\nLine 3\n');
            await service.addComment({ path: 'few.md', content: 'One comment', startLine: 1, endLine: 1 });
            await service.addComment({ path: 'many.md', content: 'Comment 1', startLine: 1, endLine: 1 });
            await service.addComment({ path: 'many.md', content: 'Comment 2', startLine: 2, endLine: 2 });
            await service.addComment({ path: 'many.md', content: 'Comment 3', startLine: 3, endLine: 3 });
            const result = await service.listCommentedNotes();
            expect(result.notes[0].path).toBe('many.md');
            expect(result.notes[1].path).toBe('few.md');
        });
        it('filters by status', async () => {
            await service.addComment({ path: 'note.md', content: 'Open', startLine: 1, endLine: 1 });
            const resolved = await service.addComment({ path: 'note.md', content: 'Resolved', startLine: 3, endLine: 3 });
            await service.resolveComment({ path: 'note.md', commentId: resolved.commentId });
            await writeFile(join(vaultPath, 'all-resolved.md'), '# Done\n');
            const allRes = await service.addComment({ path: 'all-resolved.md', content: 'Done', startLine: 1, endLine: 1 });
            await service.resolveComment({ path: 'all-resolved.md', commentId: allRes.commentId });
            // Filter for open — should exclude all-resolved.md
            const openResult = await service.listCommentedNotes({ status: 'open' });
            expect(openResult.notes).toHaveLength(1);
            expect(openResult.notes[0].path).toBe('note.md');
        });
        it('computes summary correctly', async () => {
            await writeFile(join(vaultPath, 'other.md'), '# Other\nLine\n');
            await service.addComment({ path: 'note.md', content: 'Open 1', startLine: 1, endLine: 1 });
            await service.addComment({ path: 'note.md', content: 'Open 2', startLine: 3, endLine: 3 });
            const toResolve = await service.addComment({ path: 'other.md', content: 'To resolve', startLine: 1, endLine: 1 });
            await service.resolveComment({ path: 'other.md', commentId: toResolve.commentId });
            const result = await service.listCommentedNotes();
            expect(result.summary.notesWithComments).toBe(2);
            expect(result.summary.totalOpen).toBe(2);
            expect(result.summary.totalResolved).toBe(1);
        });
        it('skips malformed sidecar files', async () => {
            await writeFile(join(vaultPath, 'bad.md.comments.json'), 'not json');
            await service.addComment({ path: 'note.md', content: 'Good', startLine: 1, endLine: 1 });
            const result = await service.listCommentedNotes();
            expect(result.notes).toHaveLength(1);
            expect(result.notes[0].path).toBe('note.md');
        });
        it('skips empty comment files', async () => {
            const empty = {
                version: 1,
                createdBy: 'test',
                note_path: 'empty.md',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                comments: [],
                metadata: { total_comments: 0, open_count: 0, resolved_count: 0, authors: [] },
            };
            await writeFile(join(vaultPath, 'empty.md.comments.json'), JSON.stringify(empty));
            const result = await service.listCommentedNotes();
            expect(result.notes).toHaveLength(0);
        });
    });
    // ============================================================================
    // PLUGIN COMPATIBILITY
    // ============================================================================
    describe('plugin compatibility', () => {
        it('reads comments created by the obsidian-annotated plugin', async () => {
            // Exact format from 07-Plugin-Implemented
            const pluginSidecar = {
                version: 1,
                createdBy: 'obsidian-annotated@0.1.0',
                note_path: 'note.md',
                created_at: '2025-01-15T10:00:00.000Z',
                updated_at: '2025-01-15T12:30:00.000Z',
                comments: [
                    {
                        id: 'c_m1abc2def3',
                        author: 'alice',
                        created_at: '2025-01-15T10:00:00.000Z',
                        location: { type: 'range', start_line: 3, start_char: 0, end_line: 3, end_char: 0 },
                        content: 'This needs a test',
                        status: 'open',
                        replies: [
                            {
                                id: 'c_m1xyz9abc1',
                                author: 'bob',
                                created_at: '2025-01-15T10:05:00.000Z',
                                content: "I'll add one",
                                status: 'open',
                            },
                        ],
                        last_activity_at: '2025-01-15T10:05:00.000Z',
                        content_snippet: 'Line 3 content',
                    },
                ],
                metadata: {
                    total_comments: 1,
                    open_count: 1,
                    resolved_count: 0,
                    authors: ['alice', 'bob'],
                },
            };
            await writeFile(join(vaultPath, 'note.md.comments.json'), JSON.stringify(pluginSidecar, null, 2));
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments).toHaveLength(1);
            expect(result.comments[0].author).toBe('alice');
            expect(result.comments[0].replies).toHaveLength(1);
            expect(result.comments[0].replies[0].author).toBe('bob');
        });
        it('appends MCP comment without corrupting plugin-created comments', async () => {
            const pluginSidecar = {
                version: 1,
                createdBy: 'obsidian-annotated@0.1.0',
                note_path: 'note.md',
                created_at: '2025-01-15T10:00:00.000Z',
                updated_at: '2025-01-15T12:30:00.000Z',
                comments: [
                    {
                        id: 'c_m1abc2def3',
                        author: 'alice',
                        created_at: '2025-01-15T10:00:00.000Z',
                        location: { type: 'range', start_line: 1, start_char: 0, end_line: 1, end_char: 0 },
                        content: 'Plugin comment',
                        status: 'open',
                        replies: [],
                        last_activity_at: '2025-01-15T10:00:00.000Z',
                        content_snippet: '# Title',
                    },
                ],
                metadata: {
                    total_comments: 1,
                    open_count: 1,
                    resolved_count: 0,
                    authors: ['alice'],
                },
            };
            await writeFile(join(vaultPath, 'note.md.comments.json'), JSON.stringify(pluginSidecar, null, 2));
            // Add MCP comment
            await service.addComment({ path: 'note.md', content: 'MCP comment', startLine: 3, endLine: 3 });
            const result = await service.readComments({ path: 'note.md' });
            expect(result.comments).toHaveLength(2);
            expect(result.comments[0].author).toBe('alice');
            expect(result.comments[0].content).toBe('Plugin comment');
            expect(result.comments[1].author).toBe('test-author');
            expect(result.comments[1].content).toBe('MCP comment');
            expect(result.metadata.authors).toEqual(['alice', 'test-author']);
        });
    });
});
