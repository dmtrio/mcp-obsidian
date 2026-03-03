export interface ParsedNote {
  frontmatter: Record<string, any>;
  content: string;
  originalContent: string;
}

export interface NoteWriteParams {
  path: string;
  content: string;
  frontmatter?: Record<string, any>;
  mode?: 'overwrite' | 'append' | 'prepend';
}

export interface PatchNoteParams {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface PatchNoteResult {
  success: boolean;
  path: string;
  message: string;
  matchCount?: number;
}

export interface DeleteNoteParams {
  path: string;
  confirmPath: string;
}

export interface DeleteResult {
  success: boolean;
  path: string;
  message: string;
}

export interface DirectoryListing {
  files: string[];
  directories: string[];
}

export interface FrontmatterValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PathFilterConfig {
  ignoredPatterns: string[];
  allowedExtensions: string[];
  sidecarPatterns: string[];
}

// Search types
export interface SearchParams {
  query: string;
  limit?: number;
  searchContent?: boolean;
  searchFrontmatter?: boolean;
  caseSensitive?: boolean;
}

export interface SearchResult {
  p: string;        // path
  t: string;        // title
  ex: string;       // excerpt
  mc: number;       // matchCount
  ln?: number;      // lineNumber
  uri?: string;     // obsidianUri
}

// Move types
export interface MoveNoteParams {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
}

export interface MoveResult {
  success: boolean;
  oldPath: string;
  newPath: string;
  message: string;
}

// Batch read types
export interface BatchReadParams {
  paths: string[];
  includeContent?: boolean;
  includeFrontmatter?: boolean;
}

export interface BatchReadResult {
  successful: Array<{
    path: string;
    frontmatter?: Record<string, any>;
    content?: string;
    obsidianUri?: string;
  }>;
  failed: Array<{
    path: string;
    error: string;
  }>;
}

// Update frontmatter types
export interface UpdateFrontmatterParams {
  path: string;
  frontmatter: Record<string, any>;
  merge?: boolean;
}

// Note info types
export interface NoteInfo {
  path: string;
  size: number;
  modified: number; // timestamp
  hasFrontmatter: boolean;
  obsidianUri?: string;
}

// Tag management types
export interface TagManagementParams {
  path: string;
  operation: 'add' | 'remove' | 'list';
  tags?: string[];
}

export interface TagManagementResult {
  path: string;
  operation: string;
  tags: string[];
  success: boolean;
  message?: string;
}

// Vault statistics types
export interface VaultStats {
  totalNotes: number;
  totalFolders: number;
  totalSize: number;  // bytes
  recentlyModified: Array<{
    path: string;
    modified: number;  // timestamp
  }>;
}

// Comment types (obsidian-annotated plugin integration)

export const OBSIDIAN_ANNOTATED_SCHEMA_VERSION = 1;

export type CommentStatus = 'open' | 'resolved';

export interface CommentLocation {
  type: 'range';
  start_line: number;
  start_char: number;
  end_line: number;
  end_char: number;
}

export interface CommentReply {
  id: string;
  author: string;
  created_at: string;
  content: string;
  status: CommentStatus;
}

export interface Comment {
  id: string;
  author: string;
  created_at: string;
  location: CommentLocation;
  content: string;
  status: CommentStatus;
  replies: CommentReply[];
  last_activity_at: string;
  content_snippet: string;
}

export interface CommentMetadata {
  total_comments: number;
  open_count: number;
  resolved_count: number;
  authors: string[];
}

export interface CommentFile {
  version: number;
  createdBy: string;
  note_path: string;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  metadata: CommentMetadata;
}

// Comment tool parameter types

export interface ReadCommentsParams {
  path: string;
  status?: CommentStatus;
  author?: string;
  prettyPrint?: boolean;
}

export interface AddCommentParams {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  startChar?: number;
  endChar?: number;
}

export interface ReplyToCommentParams {
  path: string;
  commentId: string;
  content: string;
}

export interface ResolveCommentParams {
  path: string;
  commentId: string;
  status?: CommentStatus;
}

export interface ListCommentedNotesParams {
  path?: string;
  status?: CommentStatus;
  prettyPrint?: boolean;
}

// Comment tool result types

export interface ReadCommentsResult {
  note_path: string;
  comments: Comment[];
  metadata: CommentMetadata;
}

export interface AddCommentResult {
  success: boolean;
  commentId: string;
  path: string;
}

export interface ReplyResult {
  success: boolean;
  replyId: string;
  commentId: string;
  reopened: boolean;
}

export interface ResolveResult {
  success: boolean;
  commentId: string;
  status: CommentStatus;
}

export interface CommentedNoteSummary {
  path: string;
  total: number;
  open: number;
  resolved: number;
  authors: string[];
  lastActivity: string;
}

export interface ListCommentedNotesResult {
  notes: CommentedNoteSummary[];
  summary: {
    notesWithComments: number;
    totalOpen: number;
    totalResolved: number;
  };
}

// Watch types (reactive comment collaboration)

export type WatchStatus = 'changed' | 'timeout' | 'session_expired' | 'error';

export type WatchCommentAction = 'created' | 'reply_added' | 'reopened';

export interface WatchCommentsParams {
  path: string;
  cursor?: string;
  excludeAuthors?: string[];
}

export interface ActionableComment {
  id: string;
  note: string;
  author: string;
  content: string;
  location: CommentLocation;
  createdAt: string;
  action: WatchCommentAction;
  replies: CommentReply[];
}

export interface WatchResult {
  status: WatchStatus;
  cursor: string | null;
  comments: ActionableComment[];
  watchedPath: string;
  error?: string;
}

// Watch configuration types

export interface AgentWatchConfig {
  pollTimeout?: number;
  sessionTimeout?: number;
}

export interface WatchConfig {
  pollTimeout: number;
  sessionTimeout: number;
  maxConcurrent: number;
  agents: Record<string, AgentWatchConfig>;
}

export interface ResolvedWatchConfig {
  pollTimeout: number;
  sessionTimeout: number;
  maxConcurrent: number;
}

// Cursor state (server-side, not exposed to AI)

export interface SeenCommentState {
  replyCount: number;
  status: CommentStatus;
  lastActivityAt: string;
}

export interface CursorState {
  id: string;
  folder: string;
  agentName: string;
  sessionStart: Date;
  lastChecked: Date;
  seenComments: Map<string, SeenCommentState>;
}