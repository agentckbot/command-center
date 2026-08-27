<script setup lang="ts">
import { computed } from 'vue'
import { useApi } from '../composables/useApi'

interface TradeWindow {
  label: string
  start: string
  end: string
}

interface TradePlayReview {
  outcome: 'hit-target' | 'stopped-out' | 'partial' | 'missed'
  resultPct: number
  note: string
}

interface TradePlay {
  symbol: string
  company: string
  bias: 'long' | 'short'
  entryLow: number
  entryHigh: number
  stopLoss: number
  targetOne: number
  targetTwo: number
  thesis: string
  setupTrigger: string
  exitPlan: string
  windows: TradeWindow[]
  review?: TradePlayReview
}

interface DayReview {
  reviewedAt: string
  verdict: 'strong' | 'mixed' | 'weak'
  note: string
}

type TradeRecordType = 'seeded-sample' | 'historical-verified' | 'generated-research'

interface TradeEntry {
  id: string
  tradeDate: string
  publishedAt: string
  recordType: TradeRecordType
  sourceNote: string
  focus: string
  marketNote: string
  plays: TradePlay[]
  review?: DayReview
  reviewStatus: 'watching' | 'window-open' | 'due' | 'reviewed'
  reviewWindow: {
    startDate: string
    endDate: string
  }
  playSummary: {
    reviewed: number
    wins: number
    losses: number
    partials: number
    missed: number
  }
}

interface TradeJournalResponse {
  generatedAt: string
  stats: {
    days: number
    setups: number
    reviewedDays: number
    windowOpenDays: number
    dueDays: number
    reviewedSetups: number
    wins: number
    losses: number
    partials: number
    missed: number
  }
  entries: TradeEntry[]
}

const { data: journal, loading, error } = useApi<TradeJournalResponse>('/api/trades')

const stats = computed(() => journal.value?.stats ?? {
  days: 0,
  setups: 0,
  reviewedDays: 0,
  windowOpenDays: 0,
  dueDays: 0,
  reviewedSetups: 0,
  wins: 0,
  losses: 0,
  partials: 0,
  missed: 0,
})

function formatDay(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`
}

function formatPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function statusLabel(status: TradeEntry['reviewStatus']): string {
  if (status === 'reviewed') return 'Reviewed'
  if (status === 'due') return 'Review due'
  if (status === 'window-open') return 'Review window open'
  return 'Watching'
}

function statusClass(status: TradeEntry['reviewStatus']): string {
  return `status-${status}`
}

function outcomeLabel(outcome: TradePlayReview['outcome']): string {
  if (outcome === 'hit-target') return 'Hit target'
  if (outcome === 'stopped-out') return 'Stopped out'
  if (outcome === 'partial') return 'Partial'
  return 'Missed'
}

function verdictClass(verdict: DayReview['verdict']): string {
  return `verdict-${verdict}`
}

function recordTypeLabel(recordType: TradeEntry['recordType']): string {
  if (recordType === 'historical-verified') return 'Verified history'
  if (recordType === 'generated-research') return 'Generated research'
  return 'Sample data'
}

function reviewLabel(entry: TradeEntry): string {
  return entry.recordType === 'seeded-sample' ? 'Sample review posted' : 'Review posted'
}
</script>

<template>
  <div class="content">
    <div class="page-header">
      <div class="page-title-row">
        <h2>Trades</h2>
        <span class="page-subtitle">seeded paper-trade journal</span>
      </div>

      <div class="summary-pills">
        <div class="pill">
          <span class="pill-num">{{ stats.days }}</span>
          <span class="pill-label">days logged</span>
        </div>
        <div class="pill">
          <span class="pill-num">{{ stats.setups }}</span>
          <span class="pill-label">setups</span>
        </div>
        <div class="pill">
          <span class="pill-num">{{ stats.reviewedDays }}</span>
          <span class="pill-label">reviewed</span>
        </div>
        <div class="pill pill-warn" v-if="stats.windowOpenDays">
          <span class="pill-num">{{ stats.windowOpenDays }}</span>
          <span class="pill-label">window open</span>
        </div>
        <div class="pill pill-danger" v-if="stats.dueDays">
          <span class="pill-num">{{ stats.dueDays }}</span>
          <span class="pill-label">review due</span>
        </div>
      </div>
    </div>

    <div class="notice-card">
      <div class="notice-kicker">Research mode</div>
      <p>
        This page is structured as a paper-trade journal. Entries can be seeded samples, verified
        historical notes, or model-generated research. Verify against live market data before
        placing any real trade.
      </p>
    </div>

    <div v-if="loading" class="empty-state">Loading trade journal...</div>
    <div v-else-if="error" class="empty-state">Failed to load trade journal: {{ error }}</div>
    <div v-else-if="!journal?.entries.length" class="empty-state">No trade ideas published yet</div>
    <div v-else class="trade-list">
      <article v-for="entry in journal.entries" :key="entry.id" class="trade-card">
        <div class="trade-card-top">
          <div>
            <div class="trade-date">{{ formatDay(entry.tradeDate) }}</div>
            <div class="trade-focus">{{ entry.focus }}</div>
          </div>
          <div class="trade-badges">
            <span class="badge">{{ entry.plays.length }} setups</span>
            <span class="badge badge-sample">{{ recordTypeLabel(entry.recordType) }}</span>
            <span class="badge" :class="statusClass(entry.reviewStatus)">{{ statusLabel(entry.reviewStatus) }}</span>
          </div>
        </div>

        <div class="trade-meta">
          <div class="meta-block">
            <div class="meta-label">Published</div>
            <div class="meta-value">{{ formatMoment(entry.publishedAt) }}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Review window</div>
            <div class="meta-value">
              {{ formatDay(entry.reviewWindow.startDate) }} - {{ formatDay(entry.reviewWindow.endDate) }}
            </div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Record note</div>
            <div class="meta-value meta-note">{{ entry.sourceNote }}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Market note</div>
            <div class="meta-value meta-note">{{ entry.marketNote }}</div>
          </div>
        </div>

        <div class="plays-grid">
          <section v-for="play in entry.plays" :key="`${entry.id}-${play.symbol}`" class="play-card">
            <div class="play-head">
              <div>
                <div class="play-symbol">{{ play.symbol }}</div>
                <div class="play-company">{{ play.company }}</div>
              </div>
              <span class="bias-badge" :class="`bias-${play.bias}`">{{ play.bias }}</span>
            </div>

            <div class="plan-grid">
              <div class="plan-item">
                <span class="plan-label">Entry</span>
                <span class="plan-value">{{ formatPrice(play.entryLow) }} - {{ formatPrice(play.entryHigh) }}</span>
              </div>
              <div class="plan-item">
                <span class="plan-label">Stop</span>
                <span class="plan-value">{{ formatPrice(play.stopLoss) }}</span>
              </div>
              <div class="plan-item">
                <span class="plan-label">T1</span>
                <span class="plan-value">{{ formatPrice(play.targetOne) }}</span>
              </div>
              <div class="plan-item">
                <span class="plan-label">T2</span>
                <span class="plan-value">{{ formatPrice(play.targetTwo) }}</span>
              </div>
            </div>

            <div class="window-row">
              <span v-for="window in play.windows" :key="`${play.symbol}-${window.label}`" class="window-chip">
                {{ window.label }} {{ window.start }} - {{ window.end }}
              </span>
            </div>

            <p class="play-text"><strong>Thesis:</strong> {{ play.thesis }}</p>
            <p class="play-text"><strong>Trigger:</strong> {{ play.setupTrigger }}</p>
            <p class="play-text"><strong>Exit:</strong> {{ play.exitPlan }}</p>

            <div v-if="play.review" class="play-review">
              <div class="play-review-top">
                <span class="review-outcome">{{ outcomeLabel(play.review.outcome) }}</span>
                <span class="review-result" :class="{ negative: play.review.resultPct < 0 }">{{ formatPct(play.review.resultPct) }}</span>
              </div>
              <div class="play-review-note">{{ play.review.note }}</div>
            </div>
          </section>
        </div>

        <div v-if="entry.review" class="day-review">
          <div class="day-review-top">
            <div>
              <div class="meta-label">{{ reviewLabel(entry) }}</div>
              <div class="meta-value">{{ formatMoment(entry.review.reviewedAt) }}</div>
            </div>
            <span class="verdict-badge" :class="verdictClass(entry.review.verdict)">{{ entry.review.verdict }}</span>
          </div>
          <p>{{ entry.review.note }}</p>
          <div class="review-summary-row">
            <span>{{ entry.playSummary.wins }} wins</span>
            <span>{{ entry.playSummary.partials }} partials</span>
            <span>{{ entry.playSummary.losses }} losses</span>
            <span v-if="entry.playSummary.missed">{{ entry.playSummary.missed }} missed</span>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.content { padding: 20px 24px; }

.page-header { margin-bottom: 16px; }
.page-title-row { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.page-title-row h2 { font-size: 20px; font-weight: 600; color: #fff; }
.page-subtitle { font-size: 12px; color: var(--text-muted); }

.summary-pills { display: flex; gap: 8px; flex-wrap: wrap; }
.pill {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 11px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
}
.pill-num { font-weight: 600; font-size: 13px; color: var(--accent); }
.pill-label { color: var(--text-muted); }
.pill-warn .pill-num { color: var(--yellow); }
.pill-danger .pill-num { color: var(--red); }

.notice-card {
  margin-bottom: 16px;
  padding: 14px 16px;
  border-radius: var(--radius);
  border: 1px solid rgba(251, 191, 36, 0.2);
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.1), rgba(108, 140, 255, 0.08));
}
.notice-kicker {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--yellow);
  margin-bottom: 6px;
}
.notice-card p { color: var(--text-secondary); line-height: 1.5; }

.trade-list { display: flex; flex-direction: column; gap: 12px; }
.trade-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.trade-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}
.trade-date { font-size: 17px; font-weight: 600; color: #fff; margin-bottom: 4px; }
.trade-focus { font-size: 13px; color: var(--text-secondary); }
.trade-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

.badge {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-light);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.badge-sample { color: var(--yellow); border-color: rgba(251, 191, 36, 0.3); background: var(--yellow-dim); }
.status-reviewed { color: var(--green); border-color: rgba(52, 211, 153, 0.3); background: var(--green-dim); }
.status-window-open { color: var(--yellow); border-color: rgba(251, 191, 36, 0.3); background: var(--yellow-dim); }
.status-due { color: var(--red); border-color: rgba(248, 113, 113, 0.3); background: var(--red-dim); }
.status-watching { color: var(--accent); border-color: rgba(108, 140, 255, 0.3); background: var(--accent-dim); }

.trade-meta {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.meta-block {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
}
.meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-muted); margin-bottom: 4px; }
.meta-value { font-size: 12px; color: var(--text-primary); }
.meta-note { line-height: 1.45; color: var(--text-secondary); }

.plays-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.play-card {
  padding: 14px;
  border-radius: var(--radius-sm);
  background: rgba(13, 13, 18, 0.55);
  border: 1px solid var(--border);
}
.play-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}
.play-symbol { font-size: 18px; font-weight: 700; letter-spacing: 0.3px; }
.play-company { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.bias-badge {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.bias-long { color: var(--green); background: var(--green-dim); }
.bias-short { color: var(--red); background: var(--red-dim); }

.plan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.plan-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}
.plan-label { display: block; font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
.plan-value { font-size: 12px; font-weight: 600; color: var(--text-primary); }

.window-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.window-chip {
  font-size: 10px;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid rgba(108, 140, 255, 0.2);
  border-radius: 999px;
  padding: 4px 8px;
}

.play-text { font-size: 12px; line-height: 1.45; color: var(--text-secondary); margin-top: 8px; }
.play-text strong { color: var(--text-primary); }

.play-review {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.play-review-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.review-outcome { font-size: 11px; font-weight: 600; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px; }
.review-result { font-size: 12px; font-weight: 700; color: var(--green); }
.review-result.negative { color: var(--red); }
.play-review-note { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }

.day-review {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: rgba(52, 211, 153, 0.08);
  border: 1px solid rgba(52, 211, 153, 0.16);
}
.day-review-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 8px;
}
.verdict-badge {
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.verdict-strong { color: var(--green); background: var(--green-dim); }
.verdict-mixed { color: var(--yellow); background: var(--yellow-dim); }
.verdict-weak { color: var(--red); background: var(--red-dim); }
.day-review p { font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 8px; }
.review-summary-row { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--text-primary); }

@media (max-width: 960px) {
  .trade-meta,
  .plays-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .content { padding: 12px 16px 20px; }
  .trade-card { padding: 14px; }
  .trade-card-top { flex-direction: column; }
  .trade-badges { justify-content: flex-start; }
  .plan-grid { grid-template-columns: 1fr 1fr; }
}
</style>
