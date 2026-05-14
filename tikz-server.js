#!/usr/bin/env node
/**
 * TikZ Local Compilation Server
 *
 * Receives LaTeX documents via HTTP POST, compiles them with pdflatex + pdftocairo,
 * and returns the resulting SVG.
 *
 * Prerequisites:
 *   - A TeX distribution installed (e.g., TeX Live, MiKTeX)
 *   - pdflatex and pdftocairo available in PATH
 *
 * Usage:
 *   node tikz-server.js [port]
 *
 * Default port: 3939
 */

const http = require('http');
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.argv[2]) || 3939;
const TMP_DIR = path.join(__dirname, '.tmp', 'tikz-server');
const IS_WIN = os.platform() === 'win32';

// ─── Resolve tool paths ───
// On Windows, TeX Live may not be in PATH. Try common install locations.
function findExe(name) {
  // 1. Try bare command (already in PATH)
  try {
    const cmd = IS_WIN && !name.endsWith('.exe') ? name + '.exe' : name;
    execFileSync(cmd, ['--version'], { timeout: 5000, stdio: 'pipe' });
    return cmd;
  } catch { /* not in PATH */ }

  // 2. Search common Windows TeX Live / MiKTeX paths
  if (IS_WIN) {
    const candidates = [];
    const years = ['2026', '2025', '2024', '2023', '2022'];
    const roots = ['E:\\texlive', 'C:\\texlive'];
    for (const root of roots) {
      for (const y of years) {
        candidates.push(`${root}\\${y}\\bin\\windows\\${name}.exe`);
      }
    }
    // MiKTeX
    candidates.push(`C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\${name}.exe`);
    candidates.push(`C:\\Users\\${os.userInfo().username}\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64\\${name}.exe`);
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 3. Try `where` (Windows) or `which` (Unix) to locate it
  try {
    const cmd = IS_WIN ? `where ${name}` : `which ${name}`;
    const found = execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch { /* not found */ }

  return null;
}

// Resolve paths at startup
const PDFLATEX = findExe('pdflatex');
const PDFTOCAIRO = findExe('pdftocairo');

// Ensure temp directory exists
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Clean up old temp files (older than 5 minutes)
function cleanupOldFiles() {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(TMP_DIR)) {
      const filePath = path.join(TMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 5 * 60 * 1000) {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
  } catch { /* ignore cleanup errors */ }
}

function compile(latexSource) {
  if (!PDFLATEX || !PDFTOCAIRO) {
    const missing = [];
    if (!PDFLATEX) missing.push('pdflatex');
    if (!PDFTOCAIRO) missing.push('pdftocairo');
    throw new Error(`Missing TeX tools: ${missing.join(', ')}. Install TeX Live and ensure it is in PATH.`);
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const workDir = path.join(TMP_DIR, id);
  fs.mkdirSync(workDir, { recursive: true });

  const texFile = path.join(workDir, 'tikz.tex');

  try {
    fs.writeFileSync(texFile, latexSource, 'utf-8');

    // Step 1: pdflatex → PDF
    try {
      execFileSync(PDFLATEX, [
        '-halt-on-error',
        '-interaction=nonstopmode',
        '-output-directory', workDir,
        texFile,
      ], {
        cwd: workDir,
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch (e) {
      // Extract useful error from LaTeX log
      const logFile = path.join(workDir, 'tikz.log');
      let logTail = '';
      if (fs.existsSync(logFile)) {
        const log = fs.readFileSync(logFile, 'utf-8');
        // Find error lines
        const errorLines = log.split('\n').filter(l => l.startsWith('!') || l.startsWith('l.'));
        logTail = errorLines.slice(-10).join('\n');
      }
      throw new Error(`pdflatex failed:\n${logTail || e.stderr?.toString() || e.message}`);
    }

    const pdfFile = path.join(workDir, 'tikz.pdf');
    if (!fs.existsSync(pdfFile)) {
      throw new Error('pdflatex did not produce a PDF file');
    }

    // Step 2: pdftocairo → SVG
    let svg;
    const svgFileNoExt = path.join(workDir, 'tikz');
    const svgFileWithExt = path.join(workDir, 'tikz.svg');
    try {
      execFileSync(PDFTOCAIRO, [
        '-svg',
        'tikz.pdf',
        'tikz',
      ], {
        cwd: workDir,
        timeout: 15000,
        stdio: 'pipe',
      });
      // pdftocairo may output with or without .svg extension depending on version
      const outputFile = fs.existsSync(svgFileWithExt) ? svgFileWithExt : svgFileNoExt;
      svg = fs.readFileSync(outputFile, 'utf-8');
    } catch (e) {
      throw new Error(`pdftocairo failed: ${e.stderr?.toString() || e.message}`);
    }

    if (!svg || !svg.trim()) {
      throw new Error('pdftocairo produced empty output');
    }

    return svg;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// Rate limiting: max 1 concurrent compilation
let compiling = false;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health / status check
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
    const ready = !!(PDFLATEX && PDFTOCAIRO);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      ready,
      tools: {
        pdflatex: PDFLATEX || 'NOT FOUND',
        pdftocairo: PDFTOCAIRO || 'NOT FOUND',
      },
    }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/compile') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. POST to /compile with LaTeX source as body.');
    return;
  }

  if (compiling) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Server busy: another compilation is in progress');
    return;
  }

  // Collect body chunks
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    if (!body.trim()) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Empty request body');
      return;
    }

    compiling = true;
    try {
      const svg = compile(body);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(svg);
    } catch (e) {
      console.error('[compile error]', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(e.message);
    } finally {
      compiling = false;
      cleanupOldFiles();
    }
  });
});

server.listen(PORT, () => {
  console.log(`TikZ compilation server running at http://localhost:${PORT}`);
  console.log('');
  if (PDFLATEX && PDFTOCAIRO) {
    console.log('  pdflatex:  ', PDFLATEX);
    console.log('  pdftocairo:', PDFTOCAIRO);
    console.log('  Status:     Ready');
  } else {
    console.warn('  WARNING: Missing tools!');
    if (!PDFLATEX) console.warn('  - pdflatex:  NOT FOUND');
    if (!PDFTOCAIRO) console.warn('  - pdftocairo: NOT FOUND');
    console.warn('');
    console.warn('  Ensure TeX Live is installed and its bin directory is in PATH.');
    console.warn('  Common path: E:\\texlive\\2026\\bin\\windows\\');
  }
  console.log('');
  console.log('  POST /compile  - Compile LaTeX/TikZ to SVG');
  console.log('  GET  /status   - Check server status and tool paths');
});
