<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

type WorkoutStepType = 'exercise' | 'pause'

interface WorkoutStep {
  id: string
  type: WorkoutStepType
  name: string
  durationSec: number
}

interface WorkoutDraft {
  routineName: string
  steps: WorkoutStep[]
}

interface SavedWorkoutRoutine extends WorkoutDraft {
  id: string
  updatedAt: string
}

interface WorkoutStorage {
  draft: WorkoutDraft
  savedRoutines: SavedWorkoutRoutine[]
}

interface PortableWorkoutFile {
  version: number
  exportedAt: string
  routine: WorkoutDraft
}

type AudioContextCtor = typeof AudioContext
type SaveNoticeTone = 'success' | 'error'

const STORAGE_KEY = 'command-center-workout-v1'
const EXPORT_VERSION = 1
const MAX_STEPS = 10
const MIN_DURATION_SEC = 5
const MAX_SAVED_ROUTINES = 24

let stepSeed = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
let stepDeadlineMs = 0
let audioContext: AudioContext | null = null
let activeCountdownStepId: string | null = null
let lastCountdownSecondPlayed: number | null = null

function nextStepId(): string {
  stepSeed += 1
  return `step-${Date.now()}-${stepSeed}`
}

function createStep(type: WorkoutStepType, name: string, durationSec: number): WorkoutStep {
  return {
    id: nextStepId(),
    type,
    name,
    durationSec,
  }
}

function createDefaultSteps(): WorkoutStep[] {
  return [
    createStep('exercise', 'Jumping Jacks', 40),
    createStep('pause', 'Recovery', 20),
    createStep('exercise', 'Push-Ups', 35),
    createStep('pause', 'Breathing Break', 20),
    createStep('exercise', 'Bodyweight Squats', 45),
  ]
}

const routineName = ref('Quick Circuit')
const steps = ref<WorkoutStep[]>(createDefaultSteps())
const currentStepIndex = ref(0)
const remainingMs = ref((steps.value[0]?.durationSec ?? 0) * 1000)
const running = ref(false)
const finished = ref(false)
const loaded = ref(false)
const savedRoutines = ref<SavedWorkoutRoutine[]>([])
const activeRoutineId = ref<string | null>(null)
const saveNotice = ref('')
const saveNoticeTone = ref<SaveNoticeTone>('success')
const timerLocked = ref(false)
const importInput = ref<HTMLInputElement | null>(null)

const currentStep = computed(() => steps.value[currentStepIndex.value] ?? null)
const nextStep = computed(() => steps.value[currentStepIndex.value + 1] ?? null)
const totalDurationSec = computed(() => steps.value.reduce((sum, step) => sum + step.durationSec, 0))
const canAddMore = computed(() => steps.value.length < MAX_STEPS)
const savedRoutineCount = computed(() => savedRoutines.value.length)
const editLocked = computed(() => running.value || timerLocked.value || finished.value)
const activeProgress = computed(() => {
  if (!currentStep.value) return 0
  const total = currentStep.value.durationSec * 1000
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, 1 - remainingMs.value / total))
})
const statusLabel = computed(() => {
  if (finished.value) return 'Set complete'
  if (running.value) return currentStep.value?.type === 'pause' ? 'Rest running' : 'Exercise running'
  if (remainingMs.value !== (currentStep.value?.durationSec ?? 0) * 1000) return 'Paused'
  return 'Ready'
})

function defaultName(type: WorkoutStepType, index: number): string {
  return type === 'pause' ? `Pause ${index}` : `Exercise ${index}`
}

function sanitizeRoutineName(name: string): string {
  return name.trim() || 'Workout Set'
}

function setSaveNotice(message: string, tone: SaveNoticeTone = 'success') {
  saveNotice.value = message
  saveNoticeTone.value = tone
}

function normalizeStoredSteps(rawSteps: unknown): WorkoutStep[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return createDefaultSteps()
  }

  return rawSteps
    .slice(0, MAX_STEPS)
    .map((step, index) => {
      const value = step as Partial<WorkoutStep>
      return {
        id: typeof value.id === 'string' && value.id ? value.id : nextStepId(),
        type: value.type === 'pause' ? 'pause' : 'exercise',
        name: typeof value.name === 'string' ? value.name : defaultName('exercise', index + 1),
        durationSec: normalizeDuration(value.durationSec),
      }
    })
}

function cloneSteps(rawSteps: WorkoutStep[]): WorkoutStep[] {
  return rawSteps.map((step) => ({
    ...step,
    id: nextStepId(),
  }))
}

function createDraftPayload(): WorkoutDraft {
  return {
    routineName: sanitizeRoutineName(routineName.value),
    steps: normalizeStoredSteps(steps.value),
  }
}

function stepDisplayName(step: WorkoutStep, index: number): string {
  const trimmed = step.name.trim()
  return trimmed || defaultName(step.type, index + 1)
}

function normalizeDuration(raw: number | undefined): number {
  const numeric = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(numeric)) return MIN_DURATION_SEC
  return Math.max(MIN_DURATION_SEC, Math.min(3600, Math.floor(numeric)))
}

function resetClockToCurrentStep() {
  if (!currentStep.value) {
    remainingMs.value = 0
    return
  }
  remainingMs.value = currentStep.value.durationSec * 1000
}

function clearTicker() {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

function resetCountdownState(stepId: string | null = currentStep.value?.id ?? null) {
  activeCountdownStepId = stepId
  lastCountdownSecondPlayed = null
}

function isInteractiveSelectionTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('button, input, select, label, a, textarea')
}

function syncAfterEdit(preferredStepId: string | null = currentStep.value?.id ?? null) {
  if (preferredStepId) {
    const preferredIndex = steps.value.findIndex((step) => step.id === preferredStepId)
    if (preferredIndex >= 0) {
      currentStepIndex.value = preferredIndex
    } else if (currentStepIndex.value >= steps.value.length) {
      currentStepIndex.value = Math.max(0, steps.value.length - 1)
    }
  } else if (currentStepIndex.value >= steps.value.length) {
    currentStepIndex.value = Math.max(0, steps.value.length - 1)
  }

  if (!running.value) {
    finished.value = false
    resetClockToCurrentStep()
  }
}

function loadWorkout() {
  if (typeof window === 'undefined') return

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return

    const parsed = JSON.parse(stored) as Partial<WorkoutStorage & WorkoutDraft>
    const legacyDraft = typeof parsed.routineName === 'string' || Array.isArray(parsed.steps)
      ? {
          routineName: typeof parsed.routineName === 'string' ? parsed.routineName : 'Quick Circuit',
          steps: normalizeStoredSteps(parsed.steps),
        }
      : null

    const draft = parsed.draft ?? legacyDraft
    if (draft) {
      routineName.value = sanitizeRoutineName(draft.routineName)
      steps.value = normalizeStoredSteps(draft.steps)
    }

    if (Array.isArray(parsed.savedRoutines)) {
      savedRoutines.value = parsed.savedRoutines
        .slice(0, MAX_SAVED_ROUTINES)
        .map((routine) => ({
          id: typeof routine.id === 'string' && routine.id ? routine.id : nextStepId(),
          routineName: sanitizeRoutineName(routine.routineName),
          steps: normalizeStoredSteps(routine.steps),
          updatedAt: typeof routine.updatedAt === 'string' ? routine.updatedAt : new Date().toISOString(),
        }))
    }
  } catch {
    steps.value = createDefaultSteps()
  }
}

function saveWorkout() {
  if (!loaded.value || typeof window === 'undefined') return
  const payload: WorkoutStorage = {
    draft: createDraftPayload(),
    savedRoutines: savedRoutines.value,
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

function clearSaveNotice() {
  saveNotice.value = ''
  saveNoticeTone.value = 'success'
}

function saveCurrentRoutine() {
  const name = sanitizeRoutineName(routineName.value)
  routineName.value = name

  const existing = savedRoutines.value.find(
    (routine) => routine.id === activeRoutineId.value || routine.routineName.toLowerCase() === name.toLowerCase()
  )
  const snapshot: SavedWorkoutRoutine = {
    id: existing?.id ?? nextStepId(),
    routineName: name,
    steps: normalizeStoredSteps(steps.value),
    updatedAt: new Date().toISOString(),
  }

  const remaining = savedRoutines.value.filter((routine) => routine.id !== snapshot.id)
  savedRoutines.value = [snapshot, ...remaining].slice(0, MAX_SAVED_ROUTINES)
  activeRoutineId.value = snapshot.id
  setSaveNotice(existing ? `Updated "${name}"` : `Saved "${name}"`)
}

function loadSavedRoutine(routineId: string) {
  const routine = savedRoutines.value.find((value) => value.id === routineId)
  if (!routine) return

  clearTicker()
  running.value = false
  finished.value = false
  routineName.value = routine.routineName
  steps.value = cloneSteps(routine.steps)
  activeRoutineId.value = routine.id
  resetWorkout()
  setSaveNotice(`Loaded "${routine.routineName}"`)
}

function deleteSavedRoutine(routineId: string) {
  const routine = savedRoutines.value.find((value) => value.id === routineId)
  if (!routine) return

  savedRoutines.value = savedRoutines.value.filter((value) => value.id !== routineId)
  if (activeRoutineId.value === routineId) {
    activeRoutineId.value = null
  }
  setSaveNotice(`Deleted "${routine.routineName}"`)
}

function createNewDraft() {
  clearTicker()
  running.value = false
  finished.value = false
  activeRoutineId.value = null
  routineName.value = 'New Workout'
  steps.value = [
    createStep('exercise', 'Exercise 1', 45),
    createStep('pause', 'Pause 1', 20),
    createStep('exercise', 'Exercise 2', 45),
    createStep('pause', 'Pause 2', 20),
    createStep('exercise', 'Exercise 3', 45),
  ]
  resetWorkout()
  setSaveNotice('Started a fresh draft')
}

function selectStep(index: number, event?: Event) {
  if (running.value) return
  if (event && isInteractiveSelectionTarget(event.target)) return
  if (index < 0 || index >= steps.value.length) return

  clearTicker()
  running.value = false
  finished.value = false
  currentStepIndex.value = index
  resetClockToCurrentStep()
  resetCountdownState()
}

function sanitizeFileName(name: string): string {
  return sanitizeRoutineName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workout-set'
}

function exportCurrentRoutine() {
  if (typeof window === 'undefined') return

  const payload: PortableWorkoutFile = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    routine: createDraftPayload(),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${sanitizeFileName(payload.routine.routineName)}.workout.json`
  link.click()
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0)
  setSaveNotice(`Exported "${payload.routine.routineName}"`)
}

function openImportPicker() {
  importInput.value?.click()
}

function parseImportedRoutine(raw: unknown): WorkoutDraft | null {
  if (!raw || typeof raw !== 'object') return null

  const topLevel = raw as { routine?: unknown; draft?: unknown }
  const candidate = topLevel.routine ?? topLevel.draft ?? raw
  if (!candidate || typeof candidate !== 'object') return null

  const routine = candidate as Partial<WorkoutDraft>
  if (!Array.isArray(routine.steps) || routine.steps.length === 0) return null

  return {
    routineName: sanitizeRoutineName(typeof routine.routineName === 'string' ? routine.routineName : 'Imported Workout'),
    steps: normalizeStoredSteps(routine.steps),
  }
}

async function importRoutineFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  try {
    const parsed = JSON.parse(await file.text()) as unknown
    const imported = parseImportedRoutine(parsed)
    if (!imported) {
      throw new Error('invalid routine file')
    }

    clearTicker()
    running.value = false
    finished.value = false
    timerLocked.value = false
    activeRoutineId.value = null
    routineName.value = imported.routineName
    steps.value = imported.steps
    resetWorkout()
    setSaveNotice(`Imported "${imported.routineName}"`)
  } catch {
    setSaveNotice('Could not import that workout file', 'error')
  } finally {
    input.value = ''
  }
}

function getAudioCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext || (window as Window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
}

async function ensureAudioReady(): Promise<AudioContext | null> {
  const Ctor = getAudioCtor()
  if (!Ctor) return null
  if (!audioContext) {
    audioContext = new Ctor()
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }
  return audioContext
}

async function playTransitionSound() {
  const ctx = await ensureAudioReady()
  if (!ctx) return

  const start = ctx.currentTime
  const pattern = [
    { offset: 0, frequency: 880 },
    { offset: 0.18, frequency: 660 },
  ]

  for (const tone of pattern) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.type = 'triangle'
    oscillator.frequency.value = tone.frequency
    gain.gain.setValueAtTime(0.0001, start + tone.offset)
    gain.gain.exponentialRampToValueAtTime(0.18, start + tone.offset + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.offset + 0.12)

    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(start + tone.offset)
    oscillator.stop(start + tone.offset + 0.14)
  }
}

async function playCountdownTick(second: number) {
  const ctx = await ensureAudioReady()
  if (!ctx) return

  const start = ctx.currentTime
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()

  oscillator.type = second === 1 ? 'square' : 'sine'
  oscillator.frequency.value = second === 1 ? 1320 : 980
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(0.1, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09)

  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + 0.1)
}

function syncCountdownState(durationMs: number, reset = false) {
  const stepId = currentStep.value?.id ?? null

  if (reset || activeCountdownStepId !== stepId) {
    activeCountdownStepId = stepId
    lastCountdownSecondPlayed = null
    return
  }

  if (durationMs > 4000) {
    lastCountdownSecondPlayed = null
    return
  }

  lastCountdownSecondPlayed = Math.ceil(durationMs / 1000)
}

function maybePlayCountdownTick(remainingMsValue: number) {
  const secondsLeft = Math.ceil(remainingMsValue / 1000)
  if (secondsLeft <= 0 || secondsLeft > 4) return
  if (lastCountdownSecondPlayed === secondsLeft) return

  lastCountdownSecondPlayed = secondsLeft
  void playCountdownTick(secondsLeft)
}

function startTicker(durationMs: number, resetCountdown = false) {
  clearTicker()
  stepDeadlineMs = Date.now() + durationMs
  remainingMs.value = durationMs
  syncCountdownState(durationMs, resetCountdown)

  tickTimer = setInterval(() => {
    const nextRemaining = Math.max(0, stepDeadlineMs - Date.now())
    remainingMs.value = nextRemaining
    maybePlayCountdownTick(nextRemaining)

    if (nextRemaining <= 0) {
      advanceStep()
    }
  }, 250)
}

function startWorkout() {
  if (!currentStep.value) return
  if (finished.value) {
    currentStepIndex.value = 0
    resetClockToCurrentStep()
    resetCountdownState()
  }
  finished.value = false
  timerLocked.value = true
  running.value = true
  void ensureAudioReady()
  startTicker(remainingMs.value || currentStep.value.durationSec * 1000)
}

function pauseWorkout() {
  if (!running.value) return
  running.value = false
  remainingMs.value = Math.max(0, stepDeadlineMs - Date.now())
  clearTicker()
}

function resetWorkout() {
  clearTicker()
  running.value = false
  finished.value = false
  timerLocked.value = false
  currentStepIndex.value = 0
  resetClockToCurrentStep()
  resetCountdownState()
}

function completeWorkout() {
  clearTicker()
  running.value = false
  finished.value = true
  remainingMs.value = 0
  resetCountdownState()
}

function advanceStep() {
  clearTicker()
  void playTransitionSound()

  if (currentStepIndex.value >= steps.value.length - 1) {
    completeWorkout()
    return
  }

  currentStepIndex.value += 1
  resetClockToCurrentStep()
  resetCountdownState()

  if (running.value) {
    startTicker(remainingMs.value, true)
  }
}

function previousStep() {
  if (!steps.value.length) return
  clearTicker()
  running.value = false
  finished.value = false
  currentStepIndex.value = Math.max(0, currentStepIndex.value - 1)
  resetClockToCurrentStep()
  resetCountdownState()
}

function restartCurrentStep() {
  if (!currentStep.value) return
  finished.value = false
  resetClockToCurrentStep()
  resetCountdownState()
  if (running.value) {
    startTicker(remainingMs.value, true)
  }
}

function addStep(type: WorkoutStepType) {
  if (!canAddMore.value) return
  const typeCount = steps.value.filter((step) => step.type === type).length + 1
  const name = type === 'pause' ? `Pause ${typeCount}` : `Exercise ${typeCount}`
  const durationSec = type === 'pause' ? 20 : 45
  steps.value.push(createStep(type, name, durationSec))
  syncAfterEdit()
}

function removeStep(index: number) {
  if (steps.value.length <= 1) return
  steps.value.splice(index, 1)
  syncAfterEdit()
}

function moveStep(index: number, direction: -1 | 1) {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= steps.value.length) return
  const preferredStepId = currentStep.value?.id ?? null
  const [item] = steps.value.splice(index, 1)
  if (!item) return
  steps.value.splice(targetIndex, 0, item)
  syncAfterEdit(preferredStepId)
}

function updateDuration(step: WorkoutStep, part: 'minutes' | 'seconds', value: string) {
  const numeric = Math.max(0, Number.parseInt(value || '0', 10) || 0)
  const minutes = part === 'minutes' ? numeric : Math.floor(step.durationSec / 60)
  const seconds = part === 'seconds' ? numeric : step.durationSec % 60
  step.durationSec = normalizeDuration(minutes * 60 + Math.min(59, seconds))
  syncAfterEdit()
}

function normalizeStepName(step: WorkoutStep, index: number) {
  if (!step.name.trim()) {
    step.name = defaultName(step.type, index + 1)
  }
}

function handleTypeChange(step: WorkoutStep, index: number) {
  if (!step.name.trim() || step.name.startsWith('Exercise ') || step.name.startsWith('Pause ')) {
    step.name = defaultName(step.type, index + 1)
  }
  if (step.type === 'pause' && step.durationSec > 180) {
    step.durationSec = 30
  }
  syncAfterEdit()
}

function formatClock(milliseconds: number): string {
  const totalSeconds = Math.ceil(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatTotal(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes === 0) return `${remainder}s`
  if (remainder === 0) return `${minutes}m`
  return `${minutes}m ${remainder}s`
}

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function stepMinutes(step: WorkoutStep): number {
  return Math.floor(step.durationSec / 60)
}

function stepSeconds(step: WorkoutStep): number {
  return step.durationSec % 60
}

watch([routineName, steps, savedRoutines], saveWorkout, { deep: true })

onMounted(() => {
  loadWorkout()
  resetWorkout()
  loaded.value = true
})

onBeforeUnmount(() => {
  clearTicker()
})
</script>

<template>
  <div class="content workout-page">
    <div class="page-header">
      <div class="page-title-row">
        <div>
          <h2>Workout</h2>
          <div class="page-subtitle">build timed exercise sets with sound cues</div>
        </div>
        <button class="btn subtle" @click="playTransitionSound">Test sound</button>
      </div>

      <div class="summary-pills">
        <div class="pill">
          <span class="pill-num">{{ steps.length }}</span>
          <span class="pill-label">steps</span>
        </div>
        <div class="pill">
          <span class="pill-num">{{ savedRoutineCount }}</span>
          <span class="pill-label">saved sets</span>
        </div>
        <div class="pill">
          <span class="pill-num">{{ formatTotal(totalDurationSec) }}</span>
          <span class="pill-label">total time</span>
        </div>
        <div class="pill">
          <span class="pill-num">{{ statusLabel }}</span>
          <span class="pill-label">timer state</span>
        </div>
      </div>
    </div>

    <div class="notice-card">
      <div class="notice-kicker">Interval mode</div>
      <p>
        Build a local routine with 5-10 steps, mix exercises and pauses, and let the browser play
        a sound at every transition. Use <strong>Reset</strong> to unlock editing after a timer run.
      </p>
    </div>

    <div class="workout-grid">
      <section class="panel builder-panel">
        <div class="panel-header">
          <div>
            <span class="panel-title">Routine Builder</span>
            <span class="panel-count">local by default, portable with export/import</span>
          </div>
          <div class="builder-actions">
            <button class="btn btn-accent" :disabled="running" @click="saveCurrentRoutine">Save set</button>
            <button class="btn" :disabled="running" @click="exportCurrentRoutine">Export</button>
            <button class="btn" :disabled="running" @click="openImportPicker">Import</button>
            <button class="btn" :disabled="running" @click="createNewDraft">New draft</button>
            <button class="btn" :disabled="!canAddMore || editLocked" @click="addStep('exercise')">Add exercise</button>
            <button class="btn" :disabled="!canAddMore || editLocked" @click="addStep('pause')">Add pause</button>
          </div>
        </div>

        <div class="builder-body">
          <input
            ref="importInput"
            class="hidden-file-input"
            type="file"
            accept=".json,application/json"
            @change="importRoutineFile"
          />
          <label class="field">
            <span class="field-label">Set name</span>
            <input v-model="routineName" class="text-input set-name" :disabled="editLocked" maxlength="60" />
          </label>
          <div class="save-meta-row">
            <span class="save-note">
              {{ activeRoutineId ? 'Editing a saved set.' : 'Editing an unsaved draft.' }}
            </span>
            <span
              v-if="saveNotice"
              class="save-flash"
              :class="{ error: saveNoticeTone === 'error' }"
              @click="clearSaveNotice"
            >
              {{ saveNotice }}
            </span>
          </div>

          <div class="step-list">
            <article
              v-for="(step, index) in steps"
              :key="step.id"
              class="step-card"
              tabindex="0"
              role="button"
              :class="[
                `step-${step.type}`,
                {
                  active: index === currentStepIndex && !finished,
                  done: index < currentStepIndex || finished,
                },
              ]"
              @click="selectStep(index, $event)"
              @keydown.enter.prevent="selectStep(index)"
              @keydown.space.prevent="selectStep(index)"
            >
              <div class="step-top">
                <div class="step-index">{{ index + 1 }}</div>
                <div class="step-title-group">
                  <input
                    v-model="step.name"
                    class="text-input step-name"
                    :disabled="editLocked"
                    maxlength="60"
                    @blur="normalizeStepName(step, index)"
                  />
                  <div class="step-meta">
                    <select v-model="step.type" class="type-select" :disabled="editLocked" @change="handleTypeChange(step, index)">
                      <option value="exercise">Exercise</option>
                      <option value="pause">Pause</option>
                    </select>
                    <span class="step-chip">{{ formatTotal(step.durationSec) }}</span>
                  </div>
                </div>
              </div>

              <div class="step-controls">
                <label class="duration-field">
                  <span class="field-label">Min</span>
                  <input
                    class="number-input"
                    type="number"
                    min="0"
                    max="59"
                    :disabled="editLocked"
                    :value="stepMinutes(step)"
                    @input="updateDuration(step, 'minutes', ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <label class="duration-field">
                  <span class="field-label">Sec</span>
                  <input
                    class="number-input"
                    type="number"
                    min="0"
                    max="59"
                    :disabled="editLocked"
                    :value="stepSeconds(step)"
                    @input="updateDuration(step, 'seconds', ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <div class="step-buttons">
                  <button class="icon-btn" :disabled="editLocked || index === 0" @click="moveStep(index, -1)">Up</button>
                  <button class="icon-btn" :disabled="editLocked || index === steps.length - 1" @click="moveStep(index, 1)">Down</button>
                  <button class="icon-btn danger" :disabled="editLocked || steps.length <= 1" @click="removeStep(index)">Remove</button>
                </div>
              </div>
            </article>
          </div>

          <div class="builder-footnote">
            <span>Recommended size: 5-10 steps.</span>
            <span v-if="!canAddMore">Max reached for this set.</span>
            <span v-else-if="editLocked">Editing is locked until you reset the timer.</span>
          </div>
        </div>
      </section>

      <div class="runner-column">
        <section class="panel runner-panel">
          <div class="panel-header">
            <div>
              <span class="panel-title">{{ routineName || 'Workout Set' }}</span>
              <span class="panel-count">{{ currentStep ? `step ${currentStepIndex + 1} of ${steps.length}` : 'no steps' }}</span>
            </div>
            <div class="runner-status" :class="{ running, finished }">{{ statusLabel }}</div>
          </div>

          <div class="runner-body">
            <div class="clock-ring">
              <div class="clock-ring-fill" :style="{ transform: `scaleX(${Math.max(0.08, activeProgress)})` }"></div>
              <div class="clock-core">
                <div class="clock-type">{{ currentStep?.type === 'pause' ? 'Pause' : 'Exercise' }}</div>
                <div class="clock-time">{{ formatClock(remainingMs) }}</div>
                <div class="clock-name">{{ currentStep ? stepDisplayName(currentStep, currentStepIndex) : 'No step selected' }}</div>
              </div>
            </div>

            <div class="next-up">
              <div class="next-label">Next up</div>
              <div class="next-value">
                {{ nextStep ? `${stepDisplayName(nextStep, currentStepIndex + 1)} · ${formatTotal(nextStep.durationSec)}` : 'Finish set' }}
              </div>
            </div>

            <div class="runner-controls">
              <button v-if="!running" class="action-btn primary" @click="startWorkout">Start</button>
              <button v-else class="action-btn warn" @click="pauseWorkout">Pause</button>
              <button class="action-btn" @click="restartCurrentStep">Restart step</button>
              <button class="action-btn" @click="advanceStep">Skip</button>
              <button class="action-btn" @click="previousStep">Back</button>
              <button class="action-btn" @click="resetWorkout">Reset</button>
            </div>
          </div>
        </section>

        <section class="panel timeline-panel">
          <div class="panel-header">
            <div>
              <span class="panel-title">Saved Sets</span>
              <span class="panel-count">load a routine later</span>
            </div>
          </div>

          <div v-if="savedRoutines.length" class="saved-list">
            <div v-for="routine in savedRoutines" :key="routine.id" class="saved-row">
              <div class="saved-copy">
                <div class="saved-name">{{ routine.routineName }}</div>
                <div class="saved-meta">
                  {{ routine.steps.length }} steps ·
                  {{ formatTotal(routine.steps.reduce((sum, step) => sum + step.durationSec, 0)) }} ·
                  saved {{ formatSavedAt(routine.updatedAt) }}
                </div>
              </div>
              <div class="saved-actions">
                <button class="icon-btn" :disabled="running" @click="loadSavedRoutine(routine.id)">Load</button>
                <button class="icon-btn danger" :disabled="running" @click="deleteSavedRoutine(routine.id)">Delete</button>
              </div>
            </div>
          </div>
          <div v-else class="empty-state">No saved sets yet</div>
        </section>

        <section class="panel timeline-panel">
          <div class="panel-header">
            <div>
              <span class="panel-title">Run Order</span>
              <span class="panel-count">sound plays at each transition</span>
            </div>
          </div>

          <div class="timeline-list">
            <div
              v-for="(step, index) in steps"
              :key="`${step.id}-timeline`"
              class="timeline-row"
              :class="{
                active: index === currentStepIndex && !finished,
                done: index < currentStepIndex || finished,
              }"
              @click="selectStep(index)"
            >
              <div class="timeline-marker">{{ index + 1 }}</div>
              <div class="timeline-copy">
                <div class="timeline-name">{{ stepDisplayName(step, index) }}</div>
                <div class="timeline-meta">{{ step.type === 'pause' ? 'Pause' : 'Exercise' }} · {{ formatTotal(step.durationSec) }}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workout-page { padding-bottom: 28px; }

.page-header { margin-bottom: 16px; }
.page-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.page-title-row h2 { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
.page-subtitle { font-size: 12px; color: var(--text-muted); }

.summary-pills { display: flex; gap: 8px; flex-wrap: wrap; }
.pill {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}
.pill-num { font-size: 13px; font-weight: 700; color: var(--accent); }
.pill-label { font-size: 11px; color: var(--text-muted); }
.subtle { white-space: nowrap; }
.btn-accent {
  border-color: rgba(52, 211, 153, 0.32);
  color: var(--green);
  background: rgba(52, 211, 153, 0.08);
}

.notice-card {
  margin-bottom: 16px;
  padding: 14px 16px;
  border-radius: var(--radius);
  border: 1px solid rgba(251, 191, 36, 0.18);
  background: linear-gradient(135deg, rgba(108, 140, 255, 0.12), rgba(251, 146, 60, 0.1));
}
.notice-kicker {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--yellow);
  margin-bottom: 6px;
}
.notice-card p { color: var(--text-secondary); line-height: 1.55; }

.workout-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(340px, 0.9fr);
  gap: 16px;
}

.builder-panel,
.runner-panel,
.timeline-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.builder-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.builder-body { padding: 16px; }
.hidden-file-input { display: none; }
.field { display: block; margin-bottom: 14px; }
.save-meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: -4px 0 14px;
}
.save-note {
  font-size: 11px;
  color: var(--text-muted);
}
.save-flash {
  font-size: 11px;
  color: var(--green);
  background: rgba(52, 211, 153, 0.1);
  border: 1px solid rgba(52, 211, 153, 0.22);
  border-radius: 999px;
  padding: 4px 8px;
  cursor: pointer;
}
.save-flash.error {
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.28);
}
.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  color: var(--text-muted);
}

.text-input,
.number-input,
.type-select {
  width: 100%;
  border: 1px solid var(--border-light);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  font: inherit;
}
.text-input,
.type-select { padding: 10px 12px; }
.number-input { padding: 9px 10px; }
.text-input:disabled,
.number-input:disabled,
.type-select:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.step-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: rgba(18, 19, 28, 0.9);
  padding: 12px;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}
.step-card.active {
  border-color: rgba(108, 140, 255, 0.55);
  background: rgba(18, 24, 40, 0.95);
}
.step-card.done { opacity: 0.78; }
.step-exercise { box-shadow: inset 3px 0 0 rgba(52, 211, 153, 0.55); }
.step-pause { box-shadow: inset 3px 0 0 rgba(251, 191, 36, 0.55); }

.step-top {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  margin-bottom: 10px;
}
.step-index {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--bg-tertiary);
  color: #fff;
  font-weight: 700;
}
.step-title-group { min-width: 0; }
.step-name { margin-bottom: 8px; }
.step-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.type-select {
  width: auto;
  min-width: 130px;
}
.step-chip {
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  border: 1px solid var(--border);
}

.step-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 100px)) minmax(0, 1fr);
  gap: 10px;
  align-items: end;
}
.duration-field { display: block; }
.step-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.icon-btn,
.action-btn {
  border: 1px solid var(--border-light);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  font: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.icon-btn {
  padding: 8px 10px;
  font-size: 11px;
}
.action-btn {
  padding: 10px 14px;
  font-size: 12px;
  min-width: 88px;
}
.icon-btn:hover,
.action-btn:hover,
.btn:hover {
  border-color: var(--accent);
}
.icon-btn:disabled,
.action-btn:disabled,
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.icon-btn.danger:hover { border-color: var(--red); color: var(--red); }
.action-btn.primary {
  background: linear-gradient(135deg, rgba(52, 211, 153, 0.18), rgba(108, 140, 255, 0.16));
  border-color: rgba(52, 211, 153, 0.32);
  color: #fff;
}
.action-btn.warn {
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.3);
}

.builder-footnote {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 11px;
  color: var(--text-muted);
}

.runner-column {
  display: grid;
  gap: 16px;
}

.runner-body { padding: 18px; }
.runner-status {
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.runner-status.running {
  color: var(--green);
  border-color: rgba(52, 211, 153, 0.35);
  background: var(--green-dim);
}
.runner-status.finished {
  color: var(--yellow);
  border-color: rgba(251, 191, 36, 0.35);
  background: var(--yellow-dim);
}

.clock-ring {
  position: relative;
  overflow: hidden;
  border-radius: 22px;
  border: 1px solid rgba(108, 140, 255, 0.22);
  background: linear-gradient(180deg, rgba(24, 28, 44, 0.95), rgba(14, 15, 22, 0.98));
  min-height: 250px;
  margin-bottom: 14px;
}
.clock-ring-fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  background: linear-gradient(90deg, rgba(52, 211, 153, 0.18), rgba(108, 140, 255, 0.2), rgba(251, 191, 36, 0.18));
}
.clock-core {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  text-align: center;
  min-height: 250px;
  padding: 24px;
}
.clock-type {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: var(--text-muted);
  margin-bottom: 10px;
}
.clock-time {
  font-size: clamp(54px, 7vw, 78px);
  line-height: 1;
  font-weight: 700;
  color: #fff;
  letter-spacing: -2px;
}
.clock-name {
  margin-top: 14px;
  font-size: 16px;
  color: var(--text-secondary);
}

.next-up {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  margin-bottom: 14px;
}
.next-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.9px;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.next-value {
  font-size: 13px;
  color: var(--text-primary);
}

.runner-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.saved-list {
  padding: 10px 14px 14px;
}
.saved-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.saved-row:last-child { border-bottom: none; }
.saved-copy { min-width: 0; }
.saved-name {
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.saved-meta {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}
.saved-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.timeline-list { padding: 10px 14px 14px; }
.timeline-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.timeline-row:last-child { border-bottom: none; }
.timeline-row.active .timeline-marker {
  background: var(--accent-dim);
  border-color: rgba(108, 140, 255, 0.35);
  color: var(--accent);
}
.timeline-row.done .timeline-marker {
  background: var(--green-dim);
  border-color: rgba(52, 211, 153, 0.25);
  color: var(--green);
}
.timeline-marker {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--border-light);
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  font-weight: 700;
}
.timeline-copy { min-width: 0; }
.timeline-name { font-size: 13px; color: var(--text-primary); margin-bottom: 3px; }
.timeline-meta { font-size: 11px; color: var(--text-muted); }

@media (max-width: 1100px) {
  .workout-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .workout-page { padding-bottom: 10px; }
  .page-title-row {
    flex-direction: column;
    align-items: stretch;
  }
  .step-controls {
    grid-template-columns: 1fr 1fr;
  }
  .step-buttons {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
  .runner-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .saved-row {
    flex-direction: column;
    align-items: stretch;
  }
  .saved-actions {
    justify-content: flex-start;
  }
  .action-btn {
    width: 100%;
    min-width: 0;
  }
}
</style>
