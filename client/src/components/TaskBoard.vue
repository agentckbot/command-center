<script setup lang="ts">
import { ref, computed } from 'vue'
import PromptViewer from './PromptViewer.vue'

interface TaskItem {
  text: string
  done: boolean
  waiting: string | null
  blockReason: string | null
  date: string | null
}

interface FeatureGroup {
  feature: string
  tasks: TaskItem[]
}

interface TaskSections {
  blocked: FeatureGroup[]
  inProgress: FeatureGroup[]
  approved: FeatureGroup[]
  planned: FeatureGroup[]
  done: FeatureGroup[]
  counts: { blocked: number; inProgress: number; approved: number; planned: number; done: number; total: number }
}

interface PromptInfo {
  name: string
  filename: string
  sizeBytes: number
}

const props = defineProps<{ tasks: TaskSections; projectId: string; prompts: PromptInfo[] }>()
const emit = defineEmits<{
  (e: 'approveTask', task: string): void
  (e: 'approveFeature', feature: string): void
  (e: 'refresh'): void
  (e: 'toast', message: string, type: 'success' | 'error' | 'info'): void
}>()

const showDone = ref(false)
const viewingPrompt = ref('')
const implementRequested = ref(false)

// Add Feature state
const showAddFeature = ref(false)
const featureConcept = ref('')
const designing = ref(false)
const designError = ref('')
const designRequestId = ref('')

// Mobile accordion state — blocked and inProgress expanded by default
const collapsedSections = ref<Set<string>>(new Set(['approved', 'planned']))

function toggleSection(section: string) {
  if (collapsedSections.value.has(section)) {
    collapsedSections.value.delete(section)
  } else {
    collapsedSections.value.add(section)
  }
}

function isSectionCollapsed(section: string): boolean {
  return collapsedSections.value.has(section)
}

async function requestImplementation() {
  if (implementRequested.value) return
  implementRequested.value = true
  try {
    await fetch(`/api/projects/${props.projectId}/implement`, { method: 'POST' })
  } catch { /* button state still shows feedback */ }
  setTimeout(() => { implementRequested.value = false }, 3000)
}

function toKebab(name: string): string {
  return name
    .replace(/ —.*/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-|-$/g, '')
}

const promptSet = computed(() => {
  const set = new Set<string>()
  for (const p of props.prompts || []) set.add(p.name)
  return set
})

function hasPrompt(feature: string): boolean {
  return promptSet.value.has(toKebab(feature))
}

function promptName(feature: string): string {
  return toKebab(feature)
}

function cancelAddFeature() {
  if (designing.value) return
  showAddFeature.value = false
  featureConcept.value = ''
  designError.value = ''
}

async function submitFeatureConcept() {
  const concept = featureConcept.value.trim()
  if (!concept || designing.value) return

  designing.value = true
  designError.value = ''

  try {
    const res = await fetch(`/api/projects/${props.projectId}/design-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concept }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Request failed')

    designRequestId.value = data.requestId
    pollDesignStatus()
  } catch (err: any) {
    designing.value = false
    designError.value = err.message || 'Failed to submit'
  }
}

function pollDesignStatus() {
  setTimeout(async () => {
    try {
      const res = await fetch(`/api/projects/${props.projectId}/design-status/${designRequestId.value}`)
      const data = await res.json()

      if (data.status === 'done') {
        designing.value = false
        showAddFeature.value = false
        featureConcept.value = ''
        const name = data.featureName || 'New feature'
        const count = data.taskCount || 0
        emit('toast', `Feature designed: ${name} (${count} tasks)`, 'success')
        emit('refresh')
        return
      }

      if (data.status === 'error') {
        designing.value = false
        designError.value = data.error || 'Designer agent failed'
        return
      }

      // Still pending or designing — keep polling
      pollDesignStatus()
    } catch {
      pollDesignStatus()
    }
  }, 3000)
}
</script>

<template>
  <div class="panel" v-if="tasks">
    <div class="panel-header">
      <div><span class="panel-title">Task Board</span><span class="panel-count">{{ tasks.counts.total }} tasks</span></div>
    </div>

    <!-- Mobile: full-width implement button above sections -->
    <button
      v-if="tasks.counts.approved > 0"
      class="implement-btn-mobile mobile-only"
      :disabled="implementRequested"
      @click="requestImplementation"
    >{{ implementRequested ? 'Requested...' : `Start Implementation (${tasks.counts.approved} approved)` }}</button>

    <!-- BLOCKED -->
    <div class="task-section" :class="{ 'section-collapsed-mobile': isSectionCollapsed('blocked') }" v-if="tasks.blocked.length > 0">
      <div class="task-section-header" @click="toggleSection('blocked')">
        <div class="section-label">Blocked <span class="section-count red">{{ tasks.counts.blocked }}</span></div>
        <span class="chevron mobile-only">{{ isSectionCollapsed('blocked') ? '&#9656;' : '&#9662;' }}</span>
      </div>
      <div class="section-content" v-show="!isSectionCollapsed('blocked')">
        <div v-for="group in tasks.blocked" :key="'b-' + group.feature" class="feature-group">
          <div class="feature-header" v-if="group.feature !== 'General' || tasks.blocked.length > 1">
            <div class="feature-name">{{ group.feature }} <span class="feature-task-count">{{ group.tasks.length }} tasks</span></div>
          </div>
          <div v-for="task in group.tasks" :key="task.text" class="task-item">
            <div class="task-check"></div>
            <div class="task-content">
              <div class="task-text">{{ task.text }}</div>
              <div v-if="task.blockReason" class="blocked-reason">{{ task.blockReason }}</div>
              <div class="task-tags">
                <span v-if="task.waiting" class="task-tag tag-waiting">waiting:{{ task.waiting }}</span>
              </div>
            </div>
            <div class="task-actions">
              <button class="task-btn">Unblock</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- IN PROGRESS -->
    <div class="task-section" :class="{ 'section-collapsed-mobile': isSectionCollapsed('inProgress') }">
      <div class="task-section-header" @click="toggleSection('inProgress')">
        <div class="section-label">In Progress <span class="section-count yellow">{{ tasks.counts.inProgress }}</span></div>
        <span class="chevron mobile-only">{{ isSectionCollapsed('inProgress') ? '&#9656;' : '&#9662;' }}</span>
      </div>
      <div class="section-content" v-show="!isSectionCollapsed('inProgress')">
        <div v-if="tasks.inProgress.length === 0" class="empty-state">Nothing in progress</div>
        <div v-for="group in tasks.inProgress" :key="'ip-' + group.feature" class="feature-group">
          <div class="feature-header" v-if="group.feature !== 'General' || tasks.inProgress.length > 1">
            <div class="feature-name">{{ group.feature }} <span class="feature-task-count">{{ group.tasks.length }} tasks</span></div>
          </div>
          <div v-for="task in group.tasks" :key="task.text" class="task-item">
            <div class="task-check"></div>
            <div class="task-content">
              <div class="task-text">{{ task.text }}</div>
              <div class="task-tags">
                <span v-if="task.waiting" class="task-tag tag-waiting">waiting:{{ task.waiting }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- APPROVED -->
    <div class="task-section" :class="{ 'section-collapsed-mobile': isSectionCollapsed('approved') }">
      <div class="task-section-header" @click="toggleSection('approved')">
        <div class="section-label">Approved <span class="section-count green">{{ tasks.counts.approved }}</span></div>
        <button
          v-if="tasks.counts.approved > 0"
          class="feature-btn implement desktop-only"
          :disabled="implementRequested"
          @click.stop="requestImplementation"
        >{{ implementRequested ? 'Requested...' : 'Start Implementation' }}</button>
        <span class="chevron mobile-only">{{ isSectionCollapsed('approved') ? '&#9656;' : '&#9662;' }}</span>
      </div>
      <div class="section-content" v-show="!isSectionCollapsed('approved')">
        <div v-if="tasks.approved.length === 0" class="empty-state">Nothing approved — check Planned below</div>
        <div v-for="group in tasks.approved" :key="'a-' + group.feature" class="feature-group">
          <div class="feature-header" v-if="group.feature !== 'General' || tasks.approved.length > 1">
            <div class="feature-name">
              {{ group.feature }} <span class="feature-task-count">{{ group.tasks.length }} tasks</span>
              <span v-if="hasPrompt(group.feature)" class="prompt-badge ready" @click.stop="viewingPrompt = promptName(group.feature)">&#10003; Prompt</span>
              <span v-else class="prompt-badge missing">&#9888; No prompt</span>
            </div>
          </div>
          <div v-for="task in group.tasks" :key="task.text" class="task-item">
            <div class="task-check"></div>
            <div class="task-content">
              <div class="task-text">{{ task.text }}</div>
              <div class="task-tags">
                <span v-if="task.waiting" class="task-tag tag-waiting">waiting:{{ task.waiting }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PLANNED -->
    <div class="task-section" :class="{ 'section-collapsed-mobile': isSectionCollapsed('planned') }">
      <div class="task-section-header" @click="toggleSection('planned')">
        <div class="section-label">Planned <span class="section-count blue">{{ tasks.counts.planned }}</span></div>
        <span class="chevron mobile-only">{{ isSectionCollapsed('planned') ? '&#9656;' : '&#9662;' }}</span>
      </div>
      <div class="section-content" v-show="!isSectionCollapsed('planned')">
        <div v-if="tasks.planned.length === 0" class="empty-state">No planned tasks</div>
        <div v-for="group in tasks.planned" :key="'p-' + group.feature" class="feature-group">
          <div class="feature-header">
            <div class="feature-name">
              {{ group.feature }} <span class="feature-task-count">{{ group.tasks.length }} tasks</span>
              <span v-if="hasPrompt(group.feature)" class="prompt-badge ready" @click.stop="viewingPrompt = promptName(group.feature)">&#10003; Prompt</span>
              <span v-else class="prompt-badge missing">&#9888; No prompt</span>
            </div>
            <div class="feature-actions">
              <button class="feature-btn approve-all" @click.stop="emit('approveFeature', group.feature)">Approve All</button>
            </div>
          </div>
          <div v-for="task in group.tasks" :key="task.text" class="task-item">
            <div class="task-check"></div>
            <div class="task-content">
              <div class="task-text">{{ task.text }}</div>
              <div class="task-tags">
                <span v-if="task.waiting" class="task-tag tag-waiting">waiting:{{ task.waiting }}</span>
              </div>
            </div>
            <div class="task-actions">
              <button class="task-btn approve" @click="emit('approveTask', task.text)">Approve</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- DONE (collapsed) -->
    <div class="task-section" :class="{ 'section-collapsed-mobile': isSectionCollapsed('done') }">
      <div class="task-section-header" @click="showDone = !showDone; toggleSection('done')">
        <div class="section-label" style="color: var(--text-muted);">Done <span class="section-count muted">{{ tasks.counts.done }}</span></div>
        <span class="toggle-text desktop-only">{{ showDone ? 'Hide' : 'Show' }} &#9662;</span>
        <span class="chevron mobile-only">{{ isSectionCollapsed('done') ? '&#9656;' : '&#9662;' }}</span>
      </div>
      <div class="section-content" v-show="showDone || !isSectionCollapsed('done')">
        <template v-if="showDone">
          <div v-for="group in tasks.done" :key="'d-' + group.feature" class="feature-group done-group">
            <div class="feature-header">
              <div class="feature-name">{{ group.feature }} <span class="feature-task-count">{{ group.tasks.length }} tasks</span></div>
            </div>
            <div v-for="task in group.tasks" :key="task.text" class="task-item">
              <div class="task-check checked"></div>
              <div class="task-content">
                <div class="task-text done">{{ task.text }}</div>
              </div>
            </div>
          </div>
        </template>
        <template v-else-if="tasks.done.length > 0">
          <div class="done-summary">
            {{ tasks.done.length }} completed features ({{ tasks.counts.done }} tasks)
          </div>
        </template>
      </div>
    </div>

    <!-- Add Feature -->
    <div class="add-feature-row">
      <button class="add-feature-btn" @click="showAddFeature = true">+ Add Feature</button>
    </div>

    <!-- Add Feature Modal -->
    <Teleport to="body">
      <div class="add-feature-modal" v-if="showAddFeature">
        <div class="modal-backdrop" @click="cancelAddFeature"></div>
        <div class="modal-content">
          <h3>Add Feature</h3>
          <p class="modal-hint">Describe what you want built. An AI designer will break it down into tasks and create a coding prompt.</p>
          <textarea
            v-model="featureConcept"
            class="concept-input"
            placeholder="e.g., Add a dark mode toggle in the top bar that saves the theme preference and applies it across all views..."
            rows="6"
            :disabled="designing"
          ></textarea>
          <div class="concept-meta">
            <span class="char-count">{{ featureConcept.length }} chars</span>
          </div>
          <div v-if="designing" class="designing-state">
            <div class="designing-pulse"></div>
            <span>Designing... this may take a minute</span>
          </div>
          <div v-if="designError" class="design-error">{{ designError }}</div>
          <div class="modal-actions">
            <button class="cancel-btn" @click="cancelAddFeature" :disabled="designing">Cancel</button>
            <button
              class="submit-btn"
              @click="submitFeatureConcept"
              :disabled="!featureConcept.trim() || designing"
            >{{ designing ? 'Designing...' : 'Design Feature' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <PromptViewer
      v-if="viewingPrompt"
      :name="viewingPrompt"
      :project-id="projectId"
      @close="viewingPrompt = ''"
    />
  </div>
</template>

<style scoped>
.task-section { border-bottom: 1px solid var(--border); }
.task-section:last-child { border-bottom: none; }
.task-section-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; background: var(--bg-tertiary); cursor: pointer;
}
.task-section-header:hover { background: var(--bg-hover); }
.section-label { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.section-count { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; }
.section-count.green { background: var(--green-dim); color: var(--green); }
.section-count.yellow { background: var(--yellow-dim); color: var(--yellow); }
.section-count.red { background: var(--red-dim); color: var(--red); }
.section-count.blue { background: var(--accent-dim); color: var(--accent); }
.section-count.muted { background: rgba(100,100,120,0.1); color: var(--text-muted); }
.toggle-text { font-size: 11px; color: var(--text-muted); cursor: pointer; }

.feature-group { border-bottom: 1px solid var(--border); }
.feature-group:last-child { border-bottom: none; }
.feature-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 16px 7px 20px; background: rgba(100,100,120,0.04);
}
.feature-name { font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.feature-task-count { font-size: 10px; color: var(--text-muted); font-weight: 400; }
.feature-actions { display: flex; gap: 4px; }
.feature-btn {
  padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: transparent;
  font-size: 10px; cursor: pointer; font-family: inherit; transition: all 0.12s;
}
.feature-btn.approve-all { border-color: var(--green); color: var(--green); }
.feature-btn.approve-all:hover { background: var(--green-dim); }
.feature-btn.implement { border-color: var(--green); color: var(--green); font-size: 11px; padding: 3px 10px; }
.feature-btn.implement:hover { background: var(--green-dim); }
.feature-btn.implement:disabled { opacity: 0.5; cursor: default; }

.task-item {
  display: flex; align-items: flex-start; padding: 7px 16px 7px 32px; border-bottom: 1px solid rgba(37,37,48,0.5);
  gap: 10px; transition: background 0.1s;
}
.task-item:last-child { border-bottom: none; }
.task-item:hover { background: var(--bg-hover); }
.task-check {
  width: 15px; height: 15px; border-radius: 3px; border: 2px solid #444; flex-shrink: 0;
  margin-top: 1px; display: flex; align-items: center; justify-content: center;
}
.task-check.checked { background: var(--green); border-color: var(--green); }
.task-check.checked::after { content: '\2713'; color: #111; font-size: 9px; font-weight: 700; }
.task-content { flex: 1; min-width: 0; }
.task-text { font-size: 11px; color: var(--text-secondary); word-break: break-word; overflow-wrap: break-word; }
.task-text.done { text-decoration: line-through; color: var(--text-muted); }
.task-tags { display: flex; gap: 4px; margin-top: 3px; flex-wrap: wrap; }
.task-tag { font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
.tag-waiting { background: var(--orange-dim); color: var(--orange); }

.blocked-reason { font-size: 10px; color: var(--red); margin-top: 2px; font-style: italic; }

.task-actions { display: flex; gap: 4px; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
.task-item:hover .task-actions { opacity: 1; }
.task-btn { padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: transparent; font-size: 10px; color: var(--text-muted); cursor: pointer; font-family: inherit; }
.task-btn:hover { border-color: var(--accent); color: var(--accent); }
.task-btn.approve { border-color: var(--green); color: var(--green); }
.task-btn.approve:hover { background: var(--green-dim); }

.done-group { opacity: 0.5; }
.done-summary { padding: 10px 16px; font-size: 11px; color: var(--text-muted); text-align: center; border-top: 1px solid var(--border); }

.empty-state { padding: 12px 16px; text-align: center; color: var(--text-muted); font-size: 11px; }

.prompt-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-left: 8px; font-weight: 500; white-space: nowrap;
}
.prompt-badge.ready { background: rgba(46, 204, 113, 0.15); color: #2ecc71; cursor: pointer; }
.prompt-badge.ready:hover { background: rgba(46, 204, 113, 0.25); }
.prompt-badge.missing { background: rgba(241, 196, 15, 0.15); color: #f1c40f; }

/* Add Feature */
.add-feature-row { padding: 10px 16px; border-top: 1px solid var(--border); background: var(--bg-tertiary); }
.add-feature-btn {
  width: 100%; padding: 8px; border-radius: var(--radius-sm); border: 1px dashed var(--border);
  background: transparent; color: var(--text-muted); font-size: 12px; font-family: inherit;
  cursor: pointer; transition: all 0.15s;
}
.add-feature-btn:hover { border-color: var(--accent); color: var(--accent); }

/* Modal */
.add-feature-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.6); }
.modal-content {
  position: relative; background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 24px; width: 90%; max-width: 520px;
  max-height: 90vh; overflow-y: auto;
}
.modal-content h3 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
.modal-hint { font-size: 12px; color: var(--text-muted); margin: 0 0 14px; }
.concept-input {
  width: 100%; padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border);
  background: var(--bg-primary); color: var(--text-primary); font-size: 13px; font-family: inherit;
  outline: none; resize: vertical; box-sizing: border-box;
}
.concept-input:focus { border-color: var(--accent); }
.concept-input::placeholder { color: var(--text-muted); }
.concept-meta { display: flex; justify-content: flex-end; margin-top: 4px; }
.char-count { font-size: 10px; color: var(--text-muted); }
.designing-state {
  display: flex; align-items: center; gap: 10px; margin-top: 12px;
  font-size: 12px; color: var(--accent);
}
.designing-pulse {
  width: 10px; height: 10px; border-radius: 50%; background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
.design-error { margin-top: 10px; font-size: 12px; color: var(--red); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.cancel-btn, .submit-btn {
  padding: 8px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border);
  font-size: 12px; font-family: inherit; cursor: pointer;
}
.cancel-btn { background: transparent; color: var(--text-muted); }
.cancel-btn:hover { border-color: var(--text-secondary); color: var(--text-secondary); }
.cancel-btn:disabled { opacity: 0.4; cursor: default; }
.submit-btn { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
.submit-btn:hover { opacity: 0.9; }
.submit-btn:disabled { opacity: 0.4; cursor: default; }

/* Mobile implement button */
.implement-btn-mobile {
  display: none;
}
.chevron { font-size: 12px; color: var(--text-muted); }

@media (min-width: 769px) {
  .mobile-only { display: none !important; }
  .section-content { display: block !important; }
}

@media (max-width: 768px) {
  .desktop-only { display: none !important; }

  .implement-btn-mobile {
    display: block;
    width: calc(100% - 32px);
    margin: 10px 16px;
    padding: 12px;
    border-radius: var(--radius);
    border: 1px solid var(--green);
    background: var(--green-dim);
    color: var(--green);
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    text-align: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .implement-btn-mobile:disabled { opacity: 0.5; cursor: default; }

  .task-section-header { padding: 12px 14px; min-height: 44px; }
  .task-item { padding: 10px 14px 10px 14px; min-height: 44px; }
  .task-check { width: 18px; height: 18px; border-radius: 4px; }
  .task-text { font-size: 12px; }
  .feature-name { font-size: 14px; }
  .task-actions { opacity: 1; }
  .task-btn { padding: 5px 12px; font-size: 11px; min-height: 32px; }
  .feature-btn { padding: 5px 12px; font-size: 11px; min-height: 32px; }
  .add-feature-btn { font-size: 14px; padding: 12px; min-height: 44px; }

  .modal-content {
    width: 100%; max-width: none; height: 100%; max-height: none;
    border-radius: 0; border: none;
    display: flex; flex-direction: column;
  }
  .concept-input { flex: 1; min-height: 120px; font-size: 16px; }
  .submit-btn { min-height: 44px; font-size: 14px; }
  .cancel-btn { min-height: 44px; font-size: 14px; }
}
</style>
