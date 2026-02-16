import { join, resolve, relative, dirname } from 'path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { PathFilter } from './pathfilter.js';
import { OBSIDIAN_ANNOTATED_SCHEMA_VERSION } from './types.js';
const SIDECAR_PATTERN = '.comments.json';
export class CommentService {
    pathFilter;
    author;
    packageVersion;
    vaultPath;
    constructor(vaultPath, pathFilter, author = 'mcp-obsidian', packageVersion = '0.0.0') {
        this.pathFilter = pathFilter;
        this.author = author;
        this.packageVersion = packageVersion;
        this.vaultPath = resolve(vaultPath);
    }
    resolvePath(relativePath) {
        if (!relativePath) {
            relativePath = '';
        }
        relativePath = relativePath.trim();
        const normalizedPath = relativePath.startsWith('/')
            ? relativePath.slice(1)
            : relativePath;
        const fullPath = resolve(join(this.vaultPath, normalizedPath));
        const relativeToVault = relative(this.vaultPath, fullPath);
        if (relativeToVault.startsWith('..')) {
            throw new Error(`Path traversal not allowed: ${relativePath}. Paths must be within the vault directory.`);
        }
        return fullPath;
    }
    sidecarPath(notePath) {
        return notePath + SIDECAR_PATTERN;
    }
    generateCommentId() {
        return 'c_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
    }
    captureSnippet(noteContent, startLine) {
        const lines = noteContent.split('\n');
        const line = lines[startLine - 1] || '';
        return line.substring(0, 50);
    }
    recalculateMetadata(comments) {
        const allAuthors = new Set();
        let open = 0;
        let resolved = 0;
        for (const comment of comments) {
            allAuthors.add(comment.author);
            if (comment.status === 'open')
                open++;
            else if (comment.status === 'resolved')
                resolved++;
            for (const reply of comment.replies || []) {
                allAuthors.add(reply.author);
            }
        }
        return {
            total_comments: comments.length,
            open_count: open,
            resolved_count: resolved,
            authors: [...allAuthors].sort(),
        };
    }
    async readCommentFile(notePath) {
        const sidecar = this.sidecarPath(notePath);
        const fullSidecarPath = this.resolvePath(sidecar);
        if (!this.pathFilter.isSidecarAllowed(sidecar, SIDECAR_PATTERN)) {
            throw new Error(`Access denied: ${sidecar}. This path is restricted.`);
        }
        try {
            const content = await readFile(fullSidecarPath, 'utf-8');
            const parsed = JSON.parse(content);
            if (parsed.version > OBSIDIAN_ANNOTATED_SCHEMA_VERSION) {
                throw new Error(`Unsupported comment format version: ${parsed.version}. This server supports version ${OBSIDIAN_ANNOTATED_SCHEMA_VERSION}.`);
            }
            return parsed;
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return null;
            }
            if (error instanceof SyntaxError) {
                throw new Error(`Failed to parse comments file for ${notePath}: ${error.message}`);
            }
            throw error;
        }
    }
    async writeCommentFile(notePath, commentFile) {
        const sidecar = this.sidecarPath(notePath);
        const fullSidecarPath = this.resolvePath(sidecar);
        if (!this.pathFilter.isSidecarAllowed(sidecar, SIDECAR_PATTERN)) {
            throw new Error(`Access denied: ${sidecar}. This path is restricted.`);
        }
        await mkdir(dirname(fullSidecarPath), { recursive: true });
        commentFile.metadata = this.recalculateMetadata(commentFile.comments);
        commentFile.updated_at = new Date().toISOString();
        await writeFile(fullSidecarPath, JSON.stringify(commentFile, null, 2), 'utf-8');
    }
    createEmptyCommentFile(notePath) {
        const now = new Date().toISOString();
        return {
            version: OBSIDIAN_ANNOTATED_SCHEMA_VERSION,
            createdBy: `mcp-obsidian@${this.packageVersion}`,
            note_path: notePath,
            created_at: now,
            updated_at: now,
            comments: [],
            metadata: {
                total_comments: 0,
                open_count: 0,
                resolved_count: 0,
                authors: [],
            },
        };
    }
    findComment(comments, commentId) {
        return comments.find(c => c.id === commentId);
    }
    validateNotePath(path) {
        if (!this.pathFilter.isAllowed(path)) {
            throw new Error(`Access denied: ${path}. This path is restricted (system files like .obsidian, .git, and dotfiles are not accessible).`);
        }
    }
    async readComments(params) {
        this.validateNotePath(params.path);
        const commentFile = await this.readCommentFile(params.path);
        if (!commentFile) {
            return {
                note_path: params.path,
                comments: [],
                metadata: { total_comments: 0, open_count: 0, resolved_count: 0, authors: [] },
            };
        }
        let comments = commentFile.comments;
        if (params.status) {
            comments = comments.filter(c => c.status === params.status);
        }
        if (params.author) {
            comments = comments.filter(c => c.author === params.author);
        }
        return {
            note_path: commentFile.note_path,
            comments,
            metadata: commentFile.metadata,
        };
    }
    async addComment(params) {
        this.validateNotePath(params.path);
        // Read note to validate lines and capture snippet
        const fullNotePath = this.resolvePath(params.path);
        let noteContent;
        try {
            noteContent = await readFile(fullNotePath, 'utf-8');
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                throw new Error(`Note not found: ${params.path}`);
            }
            throw error;
        }
        const lineCount = noteContent.split('\n').length;
        if (params.startLine < 1 || params.startLine > lineCount) {
            throw new Error(`Invalid location: startLine ${params.startLine} is out of range (note has ${lineCount} lines)`);
        }
        if (params.endLine < params.startLine || params.endLine > lineCount) {
            throw new Error(`Invalid location: endLine ${params.endLine} is out of range (note has ${lineCount} lines)`);
        }
        const commentFile = await this.readCommentFile(params.path) || this.createEmptyCommentFile(params.path);
        const now = new Date().toISOString();
        const commentId = this.generateCommentId();
        const comment = {
            id: commentId,
            author: this.author,
            created_at: now,
            location: {
                type: 'range',
                start_line: params.startLine,
                start_char: params.startChar ?? 0,
                end_line: params.endLine,
                end_char: params.endChar ?? 0,
            },
            content: params.content,
            status: 'open',
            replies: [],
            last_activity_at: now,
            content_snippet: this.captureSnippet(noteContent, params.startLine),
        };
        commentFile.comments.push(comment);
        await this.writeCommentFile(params.path, commentFile);
        return {
            success: true,
            commentId,
            path: params.path,
        };
    }
    async replyToComment(params) {
        this.validateNotePath(params.path);
        const commentFile = await this.readCommentFile(params.path);
        if (!commentFile) {
            throw new Error(`No comments found for ${params.path}`);
        }
        const comment = this.findComment(commentFile.comments, params.commentId);
        if (!comment) {
            throw new Error(`Comment not found: ${params.commentId}`);
        }
        const now = new Date().toISOString();
        const replyId = this.generateCommentId();
        const reply = {
            id: replyId,
            author: this.author,
            created_at: now,
            content: params.content,
            status: 'open',
        };
        comment.replies.push(reply);
        comment.last_activity_at = now;
        const reopened = comment.status === 'resolved';
        if (reopened) {
            comment.status = 'open';
        }
        await this.writeCommentFile(params.path, commentFile);
        return {
            success: true,
            replyId,
            commentId: params.commentId,
            reopened,
        };
    }
    async resolveComment(params) {
        this.validateNotePath(params.path);
        const commentFile = await this.readCommentFile(params.path);
        if (!commentFile) {
            throw new Error(`No comments found for ${params.path}`);
        }
        const comment = this.findComment(commentFile.comments, params.commentId);
        if (!comment) {
            throw new Error(`Comment not found: ${params.commentId}`);
        }
        const targetStatus = params.status ?? 'resolved';
        comment.status = targetStatus;
        comment.last_activity_at = new Date().toISOString();
        await this.writeCommentFile(params.path, commentFile);
        return {
            success: true,
            commentId: params.commentId,
            status: targetStatus,
        };
    }
    async listCommentedNotes(params = {}) {
        const searchDir = params.path || '';
        const fullSearchDir = this.resolvePath(searchDir);
        const notes = [];
        const scan = async (dirPath, relativePath) => {
            let entries;
            try {
                entries = await readdir(dirPath, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    // Skip ignored directories
                    if (this.pathFilter.isAllowed(entryRelativePath + '/')) {
                        await scan(join(dirPath, entry.name), entryRelativePath);
                    }
                }
                else if (entry.name.endsWith(SIDECAR_PATTERN)) {
                    // Found a sidecar file
                    if (!this.pathFilter.isSidecarAllowed(entryRelativePath, SIDECAR_PATTERN)) {
                        continue;
                    }
                    try {
                        const content = await readFile(join(dirPath, entry.name), 'utf-8');
                        const commentFile = JSON.parse(content);
                        if (!commentFile.comments || commentFile.comments.length === 0) {
                            continue;
                        }
                        const metadata = this.recalculateMetadata(commentFile.comments);
                        const notePath = entryRelativePath.slice(0, -SIDECAR_PATTERN.length);
                        // Apply status filter
                        if (params.status) {
                            const matchingCount = commentFile.comments.filter(c => c.status === params.status).length;
                            if (matchingCount === 0)
                                continue;
                        }
                        notes.push({
                            path: notePath,
                            total: metadata.total_comments,
                            open: metadata.open_count,
                            resolved: metadata.resolved_count,
                            authors: metadata.authors,
                            lastActivity: commentFile.updated_at,
                        });
                    }
                    catch {
                        // Malformed sidecar — skip silently
                        continue;
                    }
                }
            }
        };
        await scan(fullSearchDir, searchDir);
        // Sort by open count descending
        notes.sort((a, b) => b.open - a.open);
        let totalOpen = 0;
        let totalResolved = 0;
        for (const note of notes) {
            totalOpen += note.open;
            totalResolved += note.resolved;
        }
        return {
            notes,
            summary: {
                notesWithComments: notes.length,
                totalOpen,
                totalResolved,
            },
        };
    }
}
