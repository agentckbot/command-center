<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '../composables/useApi'

interface ProjectTasks {
  total: number
  done: number
  todo: number
  inProgress: number
  blocked: number
  approved: number
  planned: number
}

interface Project {
  id: string
  name: string
  description: string
  status: string
  tasks: ProjectTasks
  progress: number
}

const router = useRouter()
const { data: projects, loading } = useApi<Project[]>('/api/projects')

const filter = ref<'all' | 'active' | 'paused' | 'done'>('all')

const filtered = computed(() => {
  if (!projects.value) return []
  if (filter.value === 'all') return projects.value
  return projects.value.filter(p => p.status === filter.value)
})

const counts = computed(() => {
  const all = projects.value || []
  return {
    total: all.length,
    active: all.filter(p => p.status === 'active').length,
    paused: all.filter(p => p.status === 'paused').length,
    done: all.filter(p => p.status === 'done').length,
  }
})

const totalTasks = computed(() => {
  const all = projects.value || []
  return {
    total: all.reduce((s, p) => s + p.tasks.total, 0),
    done: all.reduce((s, p) => s + p.tasks.done, 0),
    inProgress: all.reduce((s, p) => s + p.tasks.inProgress, 0),
    blocked: all.reduce((s, p) => s + p.tasks.blocked, 0),
  }
})
</script>

<template>
  <div class="content">
    <!-- Page header -->
    <div class="page-header">
      <div class="page-title-row">
        <h2>Projects</h2>
        <span class="project-count">{{ counts.total }} total</span>
      </div>

      <!-- Summary stat pills -->
      <div class="summary-pills">
        <div class="pill pill-active">
          <span class="pill-num">{{ counts.active }}</span>
          <span class="pill-label">active</span>
        </div>
        <div class="pill pill-paused">
          <span class="pill-num">{{ counts.paused }}</span>
          <span class="pill-label">paused</span>
        </div>
        <div class="pill pill-done">
          <span class="pill-num">{{ counts.done }}</span>
          <span class="pill-label">done</span>
        </div>
        <div class="pill-sep"></div>
        <div class="pill pill-tasks">
          <span class="pill-num">{{ totalTasks.done }}/{{ totalTasks.total }}</span>
          <span class="pill-label">tasks done</span>
        </div>
        <div v-if="totalTasks.inProgress" class="pill pill-inprogress">
          <span class="pill-num">{{ totalTasks.inProgress }}</span>
          <span class="pill-label">in progress</span>
        </div>
        <div v-if="totalTasks.blocked" class="pill pill-blocked">
          <span class="pill-num">{{ totalTasks.blocked }}</span>
          <span class="pill-label">blocked</span>
        </div>
      </div>
    </div>

    <!-- Filter bar -->
    <div class="filter-bar">
      <button
        v-for="f in (['all', 'active', 'paused', 'done'] as const)"
        :key="f"
        class="filter-btn"
        :class="{ active: filter === f }"
        @click="filter = f"
      >
        {{ f === 'all' ? `All (${counts.total})` : f === 'active' ? `Active (${counts.active})` : f === 'paused' ? `Paused (${counts.paused})` : `Done (${counts.done})` }}
      </button>
    </div>

    <!-- Project list -->
    <div v-if="loading" class="empty-state">Loading projects...</div>
    <div v-else-if="filtered.length === 0" class="empty-state">No projects found</div>
    <div v-else class="project-list">
      <div
        v-for="p in filtered"
        :key="p.id"
        class="project-card"
        :class="'status-' + p.status"
        @click="router.push(`/project/${p.id}`)"
      >
        <div class="card-indicator" :class="p.status"></div>

        <div class="card-main">
          <div class="card-top">
            <div class="card-identity">
              <span class="card-name">{{ p.name }}</span>
              <span class="status-badge" :class="'badge-' + p.status">{{ p.status }}</span>
            </div>
            <div class="card-badges">
              <span v-if="p.tasks.blocked" class="task-badge badge-blocked">{{ p.tasks.blocked }} blocked</span>
              <span v-if="p.tasks.inProgress" class="task-badge badge-inprogress">{{ p.tasks.inProgress }} in prog</span>
              <span v-if="p.tasks.approved" class="task-badge badge-approved">{{ p.tasks.approved }} approved</span>
              <span v-if="p.tasks.planned" class="task-badge badge-planned">{{ p.tasks.planned }} planned</span>
            </div>
          </div>

          <div class="card-desc">{{ p.description }}</div>

          <div class="card-bottom">
            <div class="progress-row">
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: p.progress + '%' }"></div>
              </div>
              <span class="progress-pct">{{ p.progress }}%</span>
              <span class="progress-detail">{{ p.tasks.done }} of {{ p.tasks.total }} tasks</span>
            </div>
          </div>
        </div>

        <div class="card-chevron">›</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.content { padding: 20px 24px; }

.page-header { margin-bottom: 16px; }
.page-title-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.page-title-row h2 { font-size: 20px; font-weight: 600; color: #fff; }
.project-count { font-size: 12px; color: var(--text-muted); }

.summary-pills { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pill {
  display: flex; align-items: baseline; gap: 4px;
  padding: 4px 10px; border-radius: 20px; font-size: 11px;
  background: var(--bg-secondary); border: 1px solid var(--border);
}
.pill-num { font-weight: 600; font-size: 13px; }
.pill-label { color: var(--text-muted); }
.pill-active .pill-num { color: var(--green); }
.pill-paused .pill-num { color: var(--yellow); }
.pill-done .pill-num { color: var(--text-muted); }
.pill-tasks .pill-num { color: var(--accent); }
.pill-inprogress .pill-num { color: var(--yellow); }
.pill-blocked .pill-num { color: var(--red); }
.pill-sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }

.filter-bar { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.filter-btn {
  padding: 5px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border);
  background: transparent; color: var(--text-muted); font-size: 11px; font-weight: 500;
  cursor: pointer; font-family: inherit; transition: all 0.12s;
}
.filter-btn:hover { border-color: var(--accent); color: var(--accent); }
.filter-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

.project-list { display: flex; flex-direction: column; gap: 8px; }

.project-card {
  display: flex; align-items: stretch;
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);
  cursor: pointer; transition: background 0.1s, border-color 0.1s;
  overflow: hidden;
}
.project-card:hover { background: var(--bg-hover); border-color: var(--border-light); }

.card-indicator { width: 3px; flex-shrink: 0; }
.card-indicator.active { background: var(--green); }
.card-indicator.paused { background: var(--yellow); }
.card-indicator.done { background: var(--text-muted); }

.card-main { flex: 1; padding: 14px 16px; min-width: 0; }

.card-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.card-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-badges { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }

.status-badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.badge-active { background: var(--green-dim); color: var(--green); }
.badge-paused { background: var(--yellow-dim); color: var(--yellow); }
.badge-done { background: rgba(100,100,120,0.12); color: var(--text-muted); }

.task-badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
.badge-blocked { background: rgba(239,68,68,0.15); color: #ef4444; }
.badge-inprogress { background: rgba(234,179,8,0.15); color: #eab308; }
.badge-approved { background: rgba(34,197,94,0.15); color: #22c55e; }
.badge-planned { background: rgba(59,130,246,0.15); color: #3b82f6; }

.card-desc { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.card-bottom { display: flex; align-items: center; }
.progress-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.progress-bar { flex: 1; max-width: 200px; height: 4px; background: var(--bg-primary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--green); border-radius: 2px; }
.progress-pct { font-size: 11px; font-weight: 600; color: var(--green); width: 32px; text-align: right; flex-shrink: 0; }
.progress-detail { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }

.card-chevron { display: flex; align-items: center; padding: 0 16px; color: var(--text-muted); font-size: 20px; flex-shrink: 0; }

@media (max-width: 768px) {
  .content { padding: 12px 16px; }
  .summary-pills { gap: 6px; }
  .card-badges { display: none; }
  .card-desc { display: none; }
  .progress-bar { max-width: 120px; }
  .card-top { flex-wrap: wrap; }
}
</style>
