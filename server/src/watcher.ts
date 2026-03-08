import * as fs from 'fs'
import * as path from 'path'
import { broadcast } from './ws.js'

const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(process.env.HOME || '', 'cksoft', 'projects')

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function debouncedBroadcast(channel: string, delayMs = 300) {
  const existing = debounceTimers.get(channel)
  if (existing) clearTimeout(existing)
  debounceTimers.set(channel, setTimeout(() => {
    broadcast(channel)
    debounceTimers.delete(channel)
  }, delayMs))
}

export function startWatchers() {
  // Watch each project's TASKS.md
  try {
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== '_template' && d.name !== 'ideas')

    for (const proj of projects) {
      const tasksPath = path.join(PROJECTS_DIR, proj.name, 'TASKS.md')
      try {
        fs.watch(tasksPath, () => {
          debouncedBroadcast('tasks')
          debouncedBroadcast('projects')
          debouncedBroadcast('waiting')
        })
      } catch { /* file might not exist */ }

      // Watch agent-tracker.json
      const trackerPath = path.join(PROJECTS_DIR, proj.name, 'scripts', 'agent-tracker.json')
      try {
        fs.watch(trackerPath, () => debouncedBroadcast('agents'))
      } catch { /* file might not exist */ }
    }
  } catch { /* projects dir might not exist */ }

  // Watch ideas directory
  const ideasDir = path.join(PROJECTS_DIR, 'ideas')
  try {
    fs.watch(ideasDir, { recursive: false }, () => debouncedBroadcast('ideas'))
  } catch { /* dir might not exist */ }

  // Watch auth-profiles.json for model cooldown state changes
  const authProfilesPath = path.join(process.env.HOME || '', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json')
  try {
    fs.watch(authProfilesPath, () => debouncedBroadcast('model-status'))
  } catch { /* file might not exist */ }

  // Watch openclaw sessions.json for agent data
  const sessionsPath = path.join(process.env.HOME || '', '.openclaw', 'sessions.json')
  try {
    fs.watch(sessionsPath, () => debouncedBroadcast('agents'))
  } catch { /* file might not exist */ }

  console.log('[watcher] File watchers started')
}
