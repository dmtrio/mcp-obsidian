import { join, resolve, relative, dirname } from 'path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { PathFilter } from './pathfilter.js';
import type {
  Comment,
  CommentFile,
  CommentMetadata,
  CommentReply,
  CommentStatus,
  ReadCommentsParams,
  ReadCommentsResult,
  AddCommentParams,
  AddCommentResult,
  ReplyToCommentParams,
  ReplyResult,
  ResolveCommentParams,
  ResolveResult,
  ListCommentedNotesParams,
  ListCommentedNotesResult,
  CommentedNoteSummary,
  ActionableComment,
  WatchCommentAction,
  SeenCommentState,
} from './types.js';
import { OBSIDIAN_ANNOTATED_SCHEMA_VERSION } from './types.js';

const SIDECAR_PATTERN = '.comments.json';

export class CommentService {
  private vaultPath: string;

  constructor(
    vaultPath: string,
    private pathFilter: PathFilter,
    private author: string = 'mcp-obsidian',
    private packageVersion: string = '0.0.0'
  ) {
    this.vaultPath = resolve(vaultPath);
  }

  private resolvePath(relativePath: string): string {
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

  private sidecarPath(notePath: string): string {
    return notePath + SIDECAR_PATTERN;
  }

  private generateCommentId(): string {
    return 'c_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }

  private captureSnippet(noteContent: string, startLine: number): string {
    const lines = noteContent.split('\n');
    const line = lines[startLine - 1] || '';
    return line.substring(0, 50);
  }

  private recalculateMetadata(comments: Comment[]): CommentMetadata {
    const allAuthors = new Set<string>();
    let open = 0;
    let resolved = 0;

    for (const comment of comments) {
      allAuthors.add(comment.author);
      if (comment.status === 'open') open++;
      else if (comment.status === 'resolved') resolved++;
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

  private async readCommentFile(notePath: string): Promise<CommentFile | null> {
    const sidecar = this.sidecarPath(notePath);
    const fullSidecarPath = this.resolvePath(sidecar);

    if (!this.pathFilter.isSidecarAllowed(sidecar, SIDECAR_PATTERN)) {
      throw new Error(`Access denied: ${sidecar}. This path is restricted.`);
    }

    try {
      const content = await readFile(fullSidecarPath, 'utf-8');
      const parsed = JSON.parse(content) as CommentFile;
      if (parsed.version > OBSIDIAN_ANNOTATED_SCHEMA_VERSION) {
        throw new Error(
          `Unsupported comment format version: ${parsed.version}. This server supports version ${OBSIDIAN_ANNOTATED_SCHEMA_VERSION}.`
        );
      }
      return parsed;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse comments file for ${notePath}: ${error.message}`);
      }
      throw error;
    }
  }

  private async writeCommentFile(notePath: string, commentFile: CommentFile): Promise<void> {
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

  private createEmptyCommentFile(notePath: string): CommentFile {
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

  private findComment(comments: Comment[], commentId: string): Comment | undefined {
    return comments.find(c => c.id === commentId);
  }

  private validateNotePath(path: string): void {
    if (!this.pathFilter.isAllowed(path)) {
      throw new Error(`Access denied: ${path}. This path is restricted (system files like .obsidian, .git, and dotfiles are not accessible).`);
    }
  }

  async readComments(params: ReadCommentsParams): Promise<ReadCommentsResult> {
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

  async addComment(params: AddCommentParams): Promise<AddCommentResult> {
    this.validateNotePath(params.path);

    // Read note to validate lines and capture snippet
    const fullNotePath = this.resolvePath(params.path);
    let noteContent: string;
    try {
      noteContent = await readFile(fullNotePath, 'utf-8');
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
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

    const comment: Comment = {
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

  async replyToComment(params: ReplyToCommentParams): Promise<ReplyResult> {
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

    const reply: CommentReply = {
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

  async resolveComment(params: ResolveCommentParams): Promise<ResolveResult> {
    this.validateNotePath(params.path);

    const commentFile = await this.readCommentFile(params.path);
    if (!commentFile) {
      throw new Error(`No comments found for ${params.path}`);
    }

    const comment = this.findComment(commentFile.comments, params.commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${params.commentId}`);
    }

    const targetStatus: CommentStatus = params.status ?? 'resolved';
    comment.status = targetStatus;
    comment.last_activity_at = new Date().toISOString();

    await this.writeCommentFile(params.path, commentFile);

    return {
      success: true,
      commentId: params.commentId,
      status: targetStatus,
    };
  }

  /**
   * Recursively scan a folder for sidecar files and invoke a callback for each.
   */
  private async scanSidecars(
    folder: string,
    callback: (commentFile: CommentFile, notePath: string) => void
  ): Promise<void> {
    const fullFolder = this.resolvePath(folder);

    const scan = async (dirPath: string, relativePath: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          if (this.pathFilter.isAllowed(entryRelativePath + '/')) {
            await scan(join(dirPath, entry.name), entryRelativePath);
          }
        } else if (entry.name.endsWith(SIDECAR_PATTERN)) {
          if (!this.pathFilter.isSidecarAllowed(entryRelativePath, SIDECAR_PATTERN)) {
            continue;
          }

          try {
            const content = await readFile(join(dirPath, entry.name), 'utf-8');
            const commentFile = JSON.parse(content) as CommentFile;
            const notePath = entryRelativePath.slice(0, -SIDECAR_PATTERN.length);
            callback(commentFile, notePath);
          } catch {
            // Malformed sidecar — skip
            continue;
          }
        }
      }
    };

    await scan(fullFolder, folder);
  }

  async listCommentedNotes(params: ListCommentedNotesParams = {}): Promise<ListCommentedNotesResult> {
    const searchDir = params.path || '';
    const notes: CommentedNoteSummary[] = [];

    await this.scanSidecars(searchDir, (commentFile, notePath) => {
      if (!commentFile.comments || commentFile.comments.length === 0) {
        return;
      }

      const metadata = this.recalculateMetadata(commentFile.comments);

      // Apply status filter
      if (params.status) {
        const matchingCount = commentFile.comments.filter(c => c.status === params.status).length;
        if (matchingCount === 0) return;
      }

      notes.push({
        path: notePath,
        total: metadata.total_comments,
        open: metadata.open_count,
        resolved: metadata.resolved_count,
        authors: metadata.authors,
        lastActivity: commentFile.updated_at,
      });
    });

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

  // ===========================================================================
  // WATCH SUPPORT — Needs-attention filtering and diffing
  // ===========================================================================

  /**
   * Determine if a comment thread needs attention from the AI.
   * A comment needs attention when the last message in the thread
   * is NOT from an excluded author.
   */
  needsAttention(comment: Comment, excludeAuthors: string[]): boolean {
    if (comment.status === 'resolved') return false;

    // Determine the last message author
    const lastMessage = comment.replies.length > 0
      ? comment.replies[comment.replies.length - 1]!
      : comment;

    const authorLower = lastMessage.author.toLowerCase();
    return !excludeAuthors.some(a => a.toLowerCase() === authorLower);
  }

  /**
   * Scan a folder for all comments that currently need attention.
   * Used on first watch call (no cursor) to find actionable comments.
   */
  async getActionableComments(
    folder: string,
    excludeAuthors: string[]
  ): Promise<ActionableComment[]> {
    const actionable: ActionableComment[] = [];

    await this.scanSidecars(folder, (commentFile, notePath) => {
      for (const comment of commentFile.comments) {
        if (this.needsAttention(comment, excludeAuthors)) {
          actionable.push(this.toActionableComment(comment, notePath, 'created'));
        }
      }
    });

    return actionable;
  }

  /**
   * Given changed sidecar files and a cursor state, return only comments
   * that newly need attention since the cursor was last checked.
   */
  getNewActionableComments(
    commentFile: CommentFile,
    notePath: string,
    seenComments: Map<string, SeenCommentState>,
    excludeAuthors: string[]
  ): ActionableComment[] {
    const actionable: ActionableComment[] = [];

    for (const comment of commentFile.comments) {
      const seen = seenComments.get(comment.id);

      let action: WatchCommentAction | null = null;

      if (!seen) {
        // New comment
        action = 'created';
      } else if (seen.status === 'resolved' && comment.status === 'open') {
        // Was resolved, now reopened
        action = 'reopened';
      } else if (comment.replies.length > seen.replyCount) {
        // New replies added
        action = 'reply_added';
      }

      if (action && this.needsAttention(comment, excludeAuthors)) {
        actionable.push(this.toActionableComment(comment, notePath, action));
      }
    }

    return actionable;
  }

  /**
   * Build a snapshot of seen comment states for cursor tracking.
   */
  buildSeenComments(commentFile: CommentFile): Map<string, SeenCommentState> {
    const seen = new Map<string, SeenCommentState>();
    for (const comment of commentFile.comments) {
      seen.set(comment.id, {
        replyCount: comment.replies.length,
        status: comment.status,
        lastActivityAt: comment.last_activity_at,
      });
    }
    return seen;
  }

  /**
   * Scan a folder for all sidecar files and build a combined seen-state map.
   * Used by the server to initialize cursor state on first watch call.
   */
  async buildSeenStateForFolder(folder: string): Promise<Map<string, SeenCommentState>> {
    const seenComments = new Map<string, SeenCommentState>();

    await this.scanSidecars(folder, (commentFile) => {
      const fileSeen = this.buildSeenComments(commentFile);
      for (const [id, state] of fileSeen) {
        seenComments.set(id, state);
      }
    });

    return seenComments;
  }

  private toActionableComment(
    comment: Comment,
    notePath: string,
    action: WatchCommentAction
  ): ActionableComment {
    return {
      id: comment.id,
      note: notePath,
      author: comment.author,
      content: comment.content,
      location: comment.location,
      createdAt: comment.created_at,
      action,
      replies: comment.replies,
    };
  }
}
