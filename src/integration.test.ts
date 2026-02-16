import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { FileSystemService } from "./filesystem.js";
import { FrontmatterHandler } from "./frontmatter.js";
import { PathFilter } from "./pathfilter.js";
import { SearchService } from "./search.js";
import { CommentService } from "./comments.js";
import { writeFile, readFile, mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { CommentFile } from "./types.js";

let testVaultPath: string;
let pathFilter: PathFilter;
let frontmatterHandler: FrontmatterHandler;
let fileSystem: FileSystemService;
let searchService: SearchService;
let commentService: CommentService;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcp-obsidian-integration-"));

  // Initialize services (same as server.ts)
  pathFilter = new PathFilter({ sidecarPatterns: [".comments.json"] });
  frontmatterHandler = new FrontmatterHandler();
  fileSystem = new FileSystemService(
    testVaultPath,
    pathFilter,
    frontmatterHandler,
  );
  searchService = new SearchService(testVaultPath, pathFilter);
  commentService = new CommentService(
    testVaultPath,
    pathFilter,
    "claude",
    "1.0.0",
  );
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================================
// INTEGRATION TESTS - END-TO-END WORKFLOW
// ============================================================================

describe("Integration: Service Layer Workflows", () => {
  test("write, read, and delete note workflow", async () => {
    // 1. Write a note with frontmatter
    await fileSystem.writeNote({
      path: "test-note.md",
      content: "# Test Note\n\nThis is a test.",
      frontmatter: { tags: ["test"], status: "draft" },
    });

    // 2. Read the note back
    const note = await fileSystem.readNote("test-note.md");
    expect(note.content).toContain("This is a test");
    expect(note.frontmatter?.tags).toEqual(["test"]);
    expect(note.frontmatter?.status).toBe("draft");

    // 3. Delete the note
    const deleteResult = await fileSystem.deleteNote({
      path: "test-note.md",
      confirmPath: "test-note.md",
    });
    expect(deleteResult.success).toBe(true);
  });

  test("search notes with special characters in filenames", async () => {
    // Create notes with special characters in paths
    const testCases = [
      {
        path: "folder (archive)/note [old].md",
        content: "# Old Note\n\nArchived keyword.",
      },
      { path: "C++/notes.md", content: "# C++ Notes\n\nProgramming keyword." },
      {
        path: "backup.2024/important.md",
        content: "# Important\n\nBackup keyword.",
      },
      { path: "price$100.md", content: "# Pricing\n\nCost keyword." },
    ];

    // Write all test notes
    for (const { path, content } of testCases) {
      if (path.includes("/")) {
        const dirName = path.split("/")[0];
        if (dirName) {
          await mkdir(join(testVaultPath, dirName), { recursive: true });
        }
      }
      await writeFile(join(testVaultPath, path), content);
    }

    // Search for keyword
    const results = await searchService.search({
      query: "keyword",
      limit: 10,
    });

    expect(results.length).toBe(4);

    // Verify paths with special characters are returned correctly
    const paths = results.map((r: any) => r.p);
    expect(paths).toContain("folder (archive)/note [old].md");
    expect(paths).toContain("C++/notes.md");
  });

  test("write note with regex special chars in content", async () => {
    const content = `# Price List

Item: Widget ($10.50)
Regex: [a-z]+ matches lowercase
Math: 2 + 2 = 4
Pattern: backup.2024/**/*.md`;

    await fileSystem.writeNote({
      path: "special-chars.md",
      content,
    });

    // Read back and verify exact content
    const note = await fileSystem.readNote("special-chars.md");
    expect(note.content).toContain("($10.50)");
    expect(note.content).toContain("[a-z]+");
    expect(note.content).toContain("2 + 2 = 4");
    expect(note.content).toContain("backup.2024/**/*.md");
  });

  test("unicode and emoji in paths and content", async () => {
    // Create folders with unicode
    await mkdir(join(testVaultPath, "日本語"), { recursive: true });
    await mkdir(join(testVaultPath, "📁"), { recursive: true });

    const testCases = [
      { path: "日本語/ノート.md", content: "# 日本語のメモ\n\nこんにちは世界" },
      { path: "📁/🎉.md", content: "# Celebration\n\n🎊 Party time! 🎈" },
    ];

    // Write notes
    for (const { path, content } of testCases) {
      await fileSystem.writeNote({ path, content });
    }

    // Read back and verify
    for (const { path, content } of testCases) {
      const note = await fileSystem.readNote(path);
      expect(note.content).toBe(content);
    }
  });

  test("security: path traversal blocked", async () => {
    const maliciousPaths = [
      "../etc/passwd",
      "../../secret.txt",
      "folder/../../../outside.md",
    ];

    for (const path of maliciousPaths) {
      await expect(fileSystem.readNote(path)).rejects.toThrow(
        /Path traversal not allowed|Access denied/,
      );
    }
  });

  test("security: blocked directories not accessible", async () => {
    // Try to access .obsidian
    await expect(fileSystem.readNote(".obsidian/app.json")).rejects.toThrow(
      /Access denied/,
    );

    // Try to access .git
    await expect(fileSystem.readNote(".git/config")).rejects.toThrow(
      /Access denied/,
    );
  });

  test("multi-step workflow: search, read multiple, update frontmatter", async () => {
    // Create several notes
    for (let i = 1; i <= 3; i++) {
      await fileSystem.writeNote({
        path: `note-${i}.md`,
        content: `# Note ${i}\n\nThis contains searchterm.`,
        frontmatter: { id: i, processed: false },
      });
    }

    // Search for notes
    const searchResults = await searchService.search({
      query: "searchterm",
      limit: 10,
    });
    expect(searchResults.length).toBe(3);

    // Read multiple notes
    const paths = searchResults.map((r) => r.p);
    const readResult = await fileSystem.readMultipleNotes({
      paths,
      includeContent: true,
      includeFrontmatter: true,
    });
    expect(readResult.successful.length).toBe(3);

    // Update frontmatter on all notes
    for (const path of paths) {
      await fileSystem.updateFrontmatter({
        path,
        frontmatter: { processed: true },
        merge: true,
      });
    }

    // Verify updates
    for (const path of paths) {
      const note = await fileSystem.readNote(path);
      expect(note.frontmatter?.processed).toBe(true);
    }
  });
});

// ============================================================================
// COMMENT COLLABORATION WORKFLOW
// ============================================================================

describe("Integration: Comment Collaboration Workflow", () => {
  test("full human-AI collaboration loop", async () => {
    // 1. Human creates a note
    await fileSystem.writeNote({
      path: "research/draft.md",
      content: "# Research Draft\n\nThe sky is green.\n\nConclusion here.\n",
      frontmatter: { status: "review" },
    });

    // 2. Human leaves a comment (simulated as plugin-created sidecar)
    const humanSidecar: CommentFile = {
      version: 1,
      createdBy: "obsidian-annotated@0.1.0",
      note_path: "research/draft.md",
      created_at: "2026-02-16T10:00:00.000Z",
      updated_at: "2026-02-16T10:00:00.000Z",
      comments: [
        {
          id: "c_human001",
          author: "bob",
          created_at: "2026-02-16T10:00:00.000Z",
          location: {
            type: "range",
            start_line: 3,
            start_char: 0,
            end_line: 3,
            end_char: 0,
          },
          content: "This is wrong, the sky is blue. Please fix.",
          status: "open",
          replies: [],
          last_activity_at: "2026-02-16T10:00:00.000Z",
          content_snippet: "The sky is green.",
        },
      ],
      metadata: {
        total_comments: 1,
        open_count: 1,
        resolved_count: 0,
        authors: ["bob"],
      },
    };
    await writeFile(
      join(testVaultPath, "research/draft.md.comments.json"),
      JSON.stringify(humanSidecar, null, 2),
    );

    // 3. AI discovers notes with comments
    const listed = await commentService.listCommentedNotes();
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]!.path).toBe("research/draft.md");
    expect(listed.notes[0]!.open).toBe(1);

    // 4. AI reads the comments
    const comments = await commentService.readComments({
      path: "research/draft.md",
      status: "open",
    });
    expect(comments.comments).toHaveLength(1);
    expect(comments.comments[0]!.content).toContain("sky is blue");

    // 5. AI fixes the note
    const patchResult = await fileSystem.patchNote({
      path: "research/draft.md",
      oldString: "The sky is green.",
      newString: "The sky is blue.",
    });
    expect(patchResult.success).toBe(true);

    // 6. AI replies to the comment
    const replyResult = await commentService.replyToComment({
      path: "research/draft.md",
      commentId: "c_human001",
      content: "Fixed — changed 'green' to 'blue' on line 3.",
    });
    expect(replyResult.success).toBe(true);
    expect(replyResult.reopened).toBe(false);

    // 7. AI resolves the comment
    const resolveResult = await commentService.resolveComment({
      path: "research/draft.md",
      commentId: "c_human001",
    });
    expect(resolveResult.success).toBe(true);
    expect(resolveResult.status).toBe("resolved");

    // 8. Verify final state
    const finalComments = await commentService.readComments({
      path: "research/draft.md",
    });
    expect(finalComments.comments[0]!.status).toBe("resolved");
    expect(finalComments.comments[0]!.replies).toHaveLength(1);
    expect(finalComments.comments[0]!.replies[0]!.author).toBe("claude");
    expect(finalComments.metadata.open_count).toBe(0);
    expect(finalComments.metadata.resolved_count).toBe(1);
    expect(finalComments.metadata.authors).toEqual(["bob", "claude"]);

    const fixedNote = await fileSystem.readNote("research/draft.md");
    expect(fixedNote.content).toContain("The sky is blue.");
  });

  test("AI leaves new comment and human reopens via reply", async () => {
    // 1. Create note
    await fileSystem.writeNote({
      path: "report.md",
      content: "# Report\n\nNeeds citation.\n\nEnd.\n",
    });

    // 2. AI adds a comment
    const addResult = await commentService.addComment({
      path: "report.md",
      content: "This paragraph needs a source citation.",
      startLine: 3,
      endLine: 3,
    });
    expect(addResult.success).toBe(true);

    // 3. Verify sidecar is valid JSON the plugin can read
    const sidecarRaw = await readFile(
      join(testVaultPath, "report.md.comments.json"),
      "utf-8",
    );
    const sidecar = JSON.parse(sidecarRaw) as CommentFile;
    expect(sidecar.version).toBe(1);
    expect(sidecar.comments[0]!.content_snippet).toBe("Needs citation.");
    expect(sidecar.comments[0]!.location.start_line).toBe(3);

    // 4. AI resolves its own comment
    await commentService.resolveComment({
      path: "report.md",
      commentId: addResult.commentId,
    });

    // 5. Human replies (simulated as another service instance) — should reopen
    const humanService = new CommentService(
      testVaultPath,
      pathFilter,
      "bob",
      "1.0.0",
    );
    const replyResult = await humanService.replyToComment({
      path: "report.md",
      commentId: addResult.commentId,
      content: "Not done yet, still needs the citation.",
    });
    expect(replyResult.reopened).toBe(true);

    // 6. Verify comment is open again
    const final = await commentService.readComments({ path: "report.md" });
    expect(final.comments[0]!.status).toBe("open");
    expect(final.comments[0]!.replies).toHaveLength(1);
  });

  test("multiple notes with comments across directories", async () => {
    // Create notes in different dirs
    await mkdir(join(testVaultPath, "project-a"), { recursive: true });
    await mkdir(join(testVaultPath, "project-b"), { recursive: true });

    await fileSystem.writeNote({
      path: "project-a/spec.md",
      content: "# Spec A\nLine 2\nLine 3\n",
    });
    await fileSystem.writeNote({
      path: "project-b/spec.md",
      content: "# Spec B\nLine 2\n",
    });
    await fileSystem.writeNote({
      path: "no-comments.md",
      content: "# Clean\n",
    });

    // Add comments to both project notes
    await commentService.addComment({
      path: "project-a/spec.md",
      content: "Review A1",
      startLine: 1,
      endLine: 1,
    });
    await commentService.addComment({
      path: "project-a/spec.md",
      content: "Review A2",
      startLine: 2,
      endLine: 2,
    });
    await commentService.addComment({
      path: "project-b/spec.md",
      content: "Review B1",
      startLine: 1,
      endLine: 1,
    });

    // List all — should find 2 notes, sorted by open count
    const allNotes = await commentService.listCommentedNotes();
    expect(allNotes.notes).toHaveLength(2);
    expect(allNotes.notes[0]!.path).toBe("project-a/spec.md"); // 2 open
    expect(allNotes.notes[1]!.path).toBe("project-b/spec.md"); // 1 open
    expect(allNotes.summary.totalOpen).toBe(3);

    // Scope to project-a
    const scopedNotes = await commentService.listCommentedNotes({
      path: "project-a",
    });
    expect(scopedNotes.notes).toHaveLength(1);
    expect(scopedNotes.notes[0]!.path).toBe("project-a/spec.md");
  });

  test("comment sidecar survives note edit", async () => {
    await fileSystem.writeNote({
      path: "editable.md",
      content: "# Title\n\nOriginal line 3.\n\nLine 5.\n",
    });

    // Add comment on line 3
    await commentService.addComment({
      path: "editable.md",
      content: "Commenting on original content",
      startLine: 3,
      endLine: 3,
    });

    // Edit the note (this doesn't touch the sidecar)
    await fileSystem.patchNote({
      path: "editable.md",
      oldString: "Original line 3.",
      newString: "Edited line 3.",
    });

    // Comments are still there and readable
    const comments = await commentService.readComments({ path: "editable.md" });
    expect(comments.comments).toHaveLength(1);
    expect(comments.comments[0]!.content_snippet).toBe("Original line 3.");
    // Plugin's snippet matcher would handle relocation — MCP just preserves the data
  });

  test("existing note tools cannot access .comments.json files", async () => {
    await fileSystem.writeNote({ path: "secret.md", content: "# Secret\n" });
    await commentService.addComment({
      path: "secret.md",
      content: "Comment",
      startLine: 1,
      endLine: 1,
    });

    // read_note should reject .comments.json
    await expect(
      fileSystem.readNote("secret.md.comments.json"),
    ).rejects.toThrow(/Access denied/);
  });
});

// ============================================================================
// PERFORMANCE TESTS
// ============================================================================

describe("Performance: Post-PR#12 Overhead", () => {
  test("pathfilter performance with many checks", () => {
    const filter = new PathFilter();
    const testPaths = [
      "notes/daily/2024-01-01.md",
      "projects/work/report (final).md",
      "archive [2023]/old-note.md",
      "C++/algorithms/sort.md",
      "backup.2024/data.md",
      ".obsidian/app.json",
      ".git/config",
      "node_modules/package/index.js",
    ];

    const start = performance.now();

    // Run 1000 iterations
    for (let i = 0; i < 1000; i++) {
      for (const path of testPaths) {
        filter.isAllowed(path);
      }
    }

    const duration = performance.now() - start;

    // Should complete in reasonable time (< 200ms for 8000 checks)
    // Increased threshold to account for CI runner variability
    expect(duration).toBeLessThan(200);
  });

  test("large batch operations performance", async () => {
    // Create 50 notes
    const paths: string[] = [];
    for (let i = 1; i <= 50; i++) {
      const path = `batch/note-${i}.md`;
      paths.push(path);
    }

    await mkdir(join(testVaultPath, "batch"), { recursive: true });
    for (const path of paths) {
      await writeFile(
        join(testVaultPath, path),
        `# Note\n\nContent for ${path}`,
      );
    }

    const start = performance.now();

    // Read all 50 notes (max batch size is 10, so this tests multiple batches)
    const batches = [];
    for (let i = 0; i < paths.length; i += 10) {
      const batchPaths = paths.slice(i, i + 10);
      batches.push(
        fileSystem.readMultipleNotes({
          paths: batchPaths,
          includeContent: true,
          includeFrontmatter: true,
        }),
      );
    }

    await Promise.all(batches);

    const duration = performance.now() - start;

    // Should complete in reasonable time (< 500ms for 50 files)
    expect(duration).toBeLessThan(500);
  });
});
