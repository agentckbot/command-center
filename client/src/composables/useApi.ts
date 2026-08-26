import { ref, onMounted, onUnmounted, type Ref } from 'vue'
import { onWsUpdate } from './useWebSocket'

function urlToChannels(url: string): string[] {
  if (url.includes('/api/stats')) return ['projects']
  if (url.match(/\/api\/projects\/[^/]+\/(git|activity|prompts)/)) return ['tasks', 'activity']
  if (url.match(/\/api\/projects\/[^/]+/)) return ['tasks', 'projects']
  if (url.includes('/api/projects')) return ['projects']
  if (url.includes('/api/trades')) return ['ideas']
  if (url.includes('/api/agents')) return ['agents']
  if (url.includes('/api/waiting')) return ['waiting']
  if (url.includes('/api/ideas')) return ['ideas']
  if (url.includes('/api/activity')) return ['activity']
  if (url.includes('/api/cron')) return ['cron']
  if (url.includes('/api/logs')) return ['logs']
  if (url.includes('/api/upcoming')) return ['projects']
  if (url.includes('/api/tasks')) return ['tasks']
  return []
}

export function useApi<T>(url: string, fallbackInterval = 120000): { data: Ref<T | null>; error: Ref<string | null>; loading: Ref<boolean>; refresh: () => Promise<void> } {
  const data = ref<T | null>(null) as Ref<T | null>
  const error = ref<string | null>(null)
  const loading = ref(true)
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  async function fetchData() {
    try {
      const res = await globalThis.fetch(url)
      if (!res.ok) throw new Error(`${res.status}`)
      data.value = await res.json()
      error.value = null
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      loading.value = false
    }
  }

  const channels = urlToChannels(url)

  onMounted(() => {
    fetchData()

    // WebSocket-driven updates
    if (channels.length > 0) {
      unsubscribe = onWsUpdate((channel) => {
        if (channels.includes(channel)) {
          fetchData()
        }
      })
    }

    // Slow fallback poll
    timer = setInterval(fetchData, fallbackInterval)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
    if (unsubscribe) unsubscribe()
  })

  return { data, error, loading, refresh: fetchData }
}
