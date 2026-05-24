import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ranchmindRoot = path.resolve(__dirname, '../../');
const stateRoot = path.join(ranchmindRoot, 'state');

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// API: Get overall status
app.get('/api/status', (req, res) => {
  try {
    const memoryRoot = path.join(stateRoot, 'memory');
    const status = {
      generated_at: new Date().toISOString(),
      training: null,
      qmt: null,
      autonomy: null,
      active_runs: []
    };

    // Load latest memory files
    const loadMemory = (baseName) => {
      const p = path.join(memoryRoot, `${baseName}-latest.json`);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
      return null;
    };

    status.training = loadMemory('training');
    status.qmt = loadMemory('qmt');
    status.autonomy = loadMemory('autonomy-loop');

    // Scan for active runs
    const runsRoot = path.join(stateRoot, 'runs');
    if (fs.existsSync(runsRoot)) {
      const dirs = fs.readdirSync(runsRoot)
        .map(d => ({ name: d, path: path.join(runsRoot, d) }))
        .filter(d => fs.statSync(d.path).isDirectory())
        .sort((a, b) => fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs)
        .slice(0, 5);

      dirs.forEach(d => {
        const statePath = path.join(d.path, 'run-state.json');
        if (fs.existsSync(statePath)) {
          const runState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          status.active_runs.push({
            id: d.name,
            phase: runState.phase,
            status: runState.lifecycle_status,
            updated_at: fs.statSync(statePath).mtime
          });
        }
      });
    }

    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get specific run attempt log
app.get('/api/run/:id/log', (req, res) => {
  const { id } = req.params;
  const attemptsDir = path.join(stateRoot, 'runs', id, 'attempts');
  if (!fs.existsSync(attemptsDir)) return res.status(404).send('Run not found');

  const attempts = fs.readdirSync(attemptsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (attempts.length === 0) return res.status(404).send('No attempts found');
  
  const content = fs.readFileSync(path.join(attemptsDir, attempts[0]), 'utf8');
  res.json(JSON.parse(content));
});

app.listen(port, () => {
  console.log(`Human Plane Dashboard active at http://localhost:${port}`);
});
