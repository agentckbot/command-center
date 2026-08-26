<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

defineProps<{
  waitingCount: number
}>()

const route = useRoute()
const router = useRouter()

const tabs = [
  { label: 'Dashboard', icon: '&#9632;', path: '/' },
  { label: 'Projects', icon: '&#9654;', path: '/projects' },
  { label: 'Trades', icon: '$', path: '/trades' },
  { label: 'Status', icon: '&#9881;', path: '/status' },
]

function isActive(tab: typeof tabs[0]): boolean {
  if (tab.path === '/') return route.path === '/'
  if (tab.path === '/projects') return route.path.startsWith('/projects') || route.path.startsWith('/project')
  return route.path.startsWith(tab.path)
}

function navigate(path: string) {
  router.push(path)
}
</script>

<template>
  <nav class="bottom-nav">
    <div
      v-for="tab in tabs"
      :key="tab.path"
      class="nav-tab"
      :class="{ active: isActive(tab) }"
      @click="navigate(tab.path)"
    >
      <span class="nav-icon" :class="{ 'nav-badge': tab.label === 'Trades' && waitingCount > 0 }">
        <span v-html="tab.icon"></span>
        <span v-if="tab.label === 'Trades' && waitingCount > 0" class="badge-dot"></span>
      </span>
      <span class="nav-label">{{ tab.label }}</span>
    </div>
  </nav>
</template>

<style scoped>
.bottom-nav {
  display: none;
}

@media (max-width: 768px) {
  .bottom-nav {
    display: flex;
    justify-content: space-around;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    padding: 6px 0;
    padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
    z-index: 100;
  }
}

.nav-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 12px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.nav-tab.active {
  color: var(--accent);
}

.nav-icon {
  font-size: 18px;
  position: relative;
  line-height: 1;
}

.nav-badge {
  position: relative;
}

.badge-dot {
  position: absolute;
  top: -2px;
  right: -6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--orange);
  border: 2px solid var(--bg-secondary);
}

.nav-label {
  font-size: 10px;
}
</style>
