import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface SymbolEntry {
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

interface IndexCache {
  files: string[];
  symbols: SymbolEntry[];
  builtAt: number;
  building: Promise<void> | null;
}

const TTL_MS = 30_000;
const MAX_FILE_BYTES = 500_000;
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.scala',
  '.php', '.swift', '.cs', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.ex', '.exs', '.hs', '.ml', '.lua', '.dart',
]);

// Keyword-based declarations (function/class/def/etc). Matches with up to 4
// leading modifier keywords (export, default, public, async, ...).
const SYMBOL_DECL = /^[\t ]*(?:(?:export|public|private|protected|static|final|async|abstract|default|pub)\s+){0,4}(function|class|interface|enum|namespace|def|func|fn|struct|trait|module|impl)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

// TS/JS PascalCase consts (React components, class-like factories):
//   export const MyComponent = (props) => ...
//   const MyClient: Client = new Client()
const SYMBOL_PASCAL_CONST = /^[\t ]*(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/gm;

// TS type aliases
const SYMBOL_TYPE_ALIAS = /^[\t ]*(?:export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*[=<]/gm;

// TS/JS class methods. Must be indented (inside a class body) and terminate
// with `{` on the same line to separate declarations from function calls.
// Covers: `foo() {`, `async foo(): Promise<X> {`, `public static foo<T>() {`.
const SYMBOL_JS_METHOD = /^[\t ]+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*([a-zA-Z_$][\w$]*)\s*(?:<[^>]+>)?\s*\([^)]*\)(?:\s*:\s*[^{=;]+?)?\s*\{\s*$/gm;

// Go methods with a receiver: `func (r *Repo) FindAccounts(...) {`
const SYMBOL_GO_METHOD = /^func\s+\([^)]+\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

// C#/Java/Kotlin methods with access modifier + return type + PascalCase name:
//   public IEnumerable<Account> FindAccounts(...)
//   public static async Task<User> FindAccounts(...)
const SYMBOL_JAVA_CS_METHOD = /^[\t ]*(?:(?:public|private|protected|internal|static|virtual|override|async|final|abstract|sealed)\s+){1,}[\w<>[\],.?]+\s+([A-Z][A-Za-z0-9_]*)\s*\(/gm;

// Names that match SYMBOL_JS_METHOD by accident (control flow, test DSLs, ctor).
const JS_METHOD_BLACKLIST = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'return', 'throw', 'try',
  'do', 'else', 'new', 'typeof', 'instanceof', 'void', 'delete',
  'describe', 'it', 'test', 'context', 'expect',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'constructor',
]);

export class ProjectIndexService {
  private caches = new Map<string, IndexCache>();

  async getFiles(projectPath: string): Promise<string[]> {
    return (await this.ensureFresh(projectPath)).files;
  }

  async getSymbols(projectPath: string): Promise<SymbolEntry[]> {
    return (await this.ensureFresh(projectPath)).symbols;
  }

  invalidate(projectPath: string): void {
    this.caches.delete(projectPath);
  }

  private async ensureFresh(projectPath: string): Promise<IndexCache> {
    let cache = this.caches.get(projectPath);
    if (!cache) {
      cache = { files: [], symbols: [], builtAt: 0, building: null };
      this.caches.set(projectPath, cache);
    }
    const isFresh = cache.builtAt > 0 && Date.now() - cache.builtAt < TTL_MS;
    if (isFresh) return cache;

    if (!cache.building) {
      const cacheRef = cache;
      cache.building = this.build(projectPath, cacheRef)
        .catch(err => {
          console.log('[project-index] Build failed:', err);
        })
        .finally(() => {
          cacheRef.building = null;
        });
    }
    // Stale-while-revalidate: return old data immediately if we have any.
    if (cache.builtAt > 0) return cache;
    await cache.building;
    return cache;
  }

  private async build(projectPath: string, cache: IndexCache): Promise<void> {
    const files = await this.buildFiles(projectPath);
    const symbols = await this.buildSymbols(projectPath, files);
    cache.files = files;
    cache.symbols = symbols;
    cache.builtAt = Date.now();
  }

  private async buildFiles(projectPath: string): Promise<string[]> {
    // Prefer `git ls-files` (respects .gitignore, includes untracked). Fall
    // back to `rg --files` for non-git projects, then bail to [].
    const tryGit = () =>
      run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], projectPath);
    const tryRg = () =>
      run('rg', ['--files', '--hidden', '-g', '!.git/', '-g', '!node_modules/'], projectPath);

    let out = '';
    try { out = await tryGit(); }
    catch { try { out = await tryRg(); } catch { out = ''; } }
    return out.split('\n').filter(Boolean);
  }

  // In-process symbol extraction. Avoids depending on ripgrep/grep (which
  // may not be installed) and lets us mix several regexes per language
  // without reconciling engine quirks.
  private async buildSymbols(projectPath: string, files: string[]): Promise<SymbolEntry[]> {
    const symbols: SymbolEntry[] = [];
    const BATCH = 50;

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      await Promise.all(batch.map(async rel => {
        const ext = extname(rel).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) return;
        let content: string;
        try {
          content = await readFile(join(projectPath, rel), 'utf-8');
        } catch {
          return;
        }
        if (content.length > MAX_FILE_BYTES) return;

        const isTsJs = ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';
        const isGo = ext === '.go';
        const isJavaCs = ext === '.java' || ext === '.cs' || ext === '.kt' || ext === '.scala';
        extractMatches(content, SYMBOL_DECL, rel, symbols, 'kind-name');
        if (isTsJs) {
          extractMatches(content, SYMBOL_PASCAL_CONST, rel, symbols, 'const');
          extractMatches(content, SYMBOL_TYPE_ALIAS, rel, symbols, 'type');
          extractMatches(content, SYMBOL_JS_METHOD, rel, symbols, 'method');
        }
        if (isGo) {
          extractMatches(content, SYMBOL_GO_METHOD, rel, symbols, 'method');
        }
        if (isJavaCs) {
          extractMatches(content, SYMBOL_JAVA_CS_METHOD, rel, symbols, 'method');
        }
      }));
      // Yield so we don't starve the event loop during a large cold build.
      if (i + BATCH < files.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    return symbols;
  }
}

// Appends every match in `content` to `out`. `shape` tells us how to read
// the capture groups:
//   kind-name → group 1 is the kind keyword, group 2 is the name
//   const     → no kind keyword; group 1 is the name, synthesize kind='const'
//   type      → synthesize kind='type'; group 1 is the name
function extractMatches(
  content: string,
  pattern: RegExp,
  filePath: string,
  out: SymbolEntry[],
  shape: 'kind-name' | 'const' | 'type' | 'method',
): void {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const prefix = content.slice(0, m.index);
    // Count newlines in the prefix — cheaper than split on big files.
    let line = 1;
    for (let i = 0; i < prefix.length; i++) if (prefix.charCodeAt(i) === 10) line++;
    if (shape === 'kind-name') {
      out.push({ kind: m[1], name: m[2], filePath, line });
    } else if (shape === 'const') {
      out.push({ kind: 'const', name: m[1], filePath, line });
    } else if (shape === 'type') {
      out.push({ kind: 'type', name: m[1], filePath, line });
    } else {
      // method — skip names that match the pattern but aren't real methods
      // (control keywords, test DSL callbacks, constructors, etc).
      if (JS_METHOD_BLACKLIST.has(m[1])) continue;
      out.push({ kind: 'method', name: m[1], filePath, line });
    }
  }
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let size = 0;
    const MAX = 32 * 1024 * 1024;
    let killed = false;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      size += chunk.length;
      if (size > MAX) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        return;
      }
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      // grep/rg exit 1 means "no matches" — not a failure.
      if (killed || code === 0 || code === 1) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

// Fuzzy subsequence scorer. Higher is better. Returns null if `query` is not
// a subsequence of `target`. Scoring:
//   +10 when a match lands on a word boundary (start, or after / - _ . space)
//   +5  when a match is consecutive with the previous one
//   +1  per matched character
//   -0.1 * (trailing length) to prefer targets where the match lands early.
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  let firstMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charCodeAt(ti) === q.charCodeAt(qi)) {
      if (firstMatch === -1) firstMatch = ti;
      const prev = ti === 0 ? '/' : t[ti - 1];
      if (prev === '/' || prev === '-' || prev === '_' || prev === '.' || prev === ' ') score += 10;
      if (prevMatch === ti - 1) score += 5;
      score += 1;
      prevMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= (t.length - firstMatch) * 0.1;
  return score;
}

// Filenames: score basename more heavily than the full path.
export function fuzzyScoreFilename(query: string, filePath: string): number | null {
  const slash = filePath.lastIndexOf('/');
  const basename = slash === -1 ? filePath : filePath.slice(slash + 1);
  const baseScore = fuzzyScore(query, basename);
  const pathScore = fuzzyScore(query, filePath);
  if (baseScore === null && pathScore === null) return null;
  const a = baseScore === null ? -Infinity : baseScore * 1.5;
  const b = pathScore === null ? -Infinity : pathScore;
  return Math.max(a, b);
}
