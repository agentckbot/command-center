import { Router } from "express";
import fs from "fs/promises";
import { TRADE_JOURNAL_FILE } from "../services/paths.js";

export const tradesRouter = Router();

interface TradeWindow {
  label: string;
  start: string;
  end: string;
}

interface TradePlayReview {
  outcome: "hit-target" | "stopped-out" | "partial" | "missed";
  resultPct: number;
  note: string;
}

interface TradePlay {
  symbol: string;
  company: string;
  bias: "long" | "short";
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  targetOne: number;
  targetTwo: number;
  thesis: string;
  setupTrigger: string;
  exitPlan: string;
  windows: TradeWindow[];
  review?: TradePlayReview;
}

interface DayReview {
  reviewedAt: string;
  verdict: "strong" | "mixed" | "weak";
  note: string;
}

type TradeRecordType =
  | "seeded-sample"
  | "historical-verified"
  | "generated-research";

interface TradeJournalEntry {
  id: string;
  tradeDate: string;
  publishedAt: string;
  recordType: TradeRecordType;
  sourceNote: string;
  focus: string;
  marketNote: string;
  plays: TradePlay[];
  review?: DayReview;
}

type ReviewStatus = "watching" | "window-open" | "due" | "reviewed";

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function compareDateOnly(left: Date, right: Date): number {
  const leftValue = Date.UTC(
    left.getUTCFullYear(),
    left.getUTCMonth(),
    left.getUTCDate()
  );
  const rightValue = Date.UTC(
    right.getUTCFullYear(),
    right.getUTCMonth(),
    right.getUTCDate()
  );
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function resolveReviewStatus(
  entry: TradeJournalEntry,
  now = new Date()
): { status: ReviewStatus; startDate: string; endDate: string } {
  const startDate = addDays(entry.tradeDate, 3);
  const endDate = addDays(entry.tradeDate, 5);

  if (entry.review) {
    return { status: "reviewed", startDate, endDate };
  }

  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  if (compareDateOnly(today, start) < 0) {
    return { status: "watching", startDate, endDate };
  }
  if (compareDateOnly(today, end) <= 0) {
    return { status: "window-open", startDate, endDate };
  }
  return { status: "due", startDate, endDate };
}

function summarizePlays(plays: TradePlay[]) {
  return plays.reduce(
    (summary, play) => {
      const outcome = play.review?.outcome;
      if (outcome === "hit-target") summary.wins += 1;
      else if (outcome === "stopped-out") summary.losses += 1;
      else if (outcome === "partial") summary.partials += 1;
      else if (outcome === "missed") summary.missed += 1;

      if (play.review) {
        summary.reviewed += 1;
      }
      return summary;
    },
    { reviewed: 0, wins: 0, losses: 0, partials: 0, missed: 0 }
  );
}

async function loadJournal(): Promise<TradeJournalEntry[]> {
  const raw = await fs.readFile(TRADE_JOURNAL_FILE, "utf-8");
  const entries = JSON.parse(raw) as Array<
    Omit<TradeJournalEntry, "recordType" | "sourceNote"> &
      Partial<Pick<TradeJournalEntry, "recordType" | "sourceNote">>
  >;
  return entries
    .map(
      (entry): TradeJournalEntry => ({
        ...entry,
        recordType: entry.recordType ?? "seeded-sample",
        sourceNote:
          entry.sourceNote ??
          "Seeded sample entry for workflow testing. This is not a verified historical trade alert.",
      })
    )
    .sort((left, right) => {
    const byDate = right.tradeDate.localeCompare(left.tradeDate);
    if (byDate !== 0) return byDate;
    return right.publishedAt.localeCompare(left.publishedAt);
  });
}

tradesRouter.get("/", async (_req, res) => {
  try {
    const entries = await loadJournal();
    const enriched = entries.map((entry) => {
      const reviewWindow = resolveReviewStatus(entry);
      const playSummary = summarizePlays(entry.plays);
      return {
        ...entry,
        reviewStatus: reviewWindow.status,
        reviewWindow: {
          startDate: reviewWindow.startDate,
          endDate: reviewWindow.endDate,
        },
        playSummary,
      };
    });

    const stats = enriched.reduce(
      (summary, entry) => {
        summary.days += 1;
        summary.setups += entry.plays.length;
        if (entry.reviewStatus === "reviewed") summary.reviewedDays += 1;
        if (entry.reviewStatus === "window-open") summary.windowOpenDays += 1;
        if (entry.reviewStatus === "due") summary.dueDays += 1;
        summary.reviewedSetups += entry.playSummary.reviewed;
        summary.wins += entry.playSummary.wins;
        summary.losses += entry.playSummary.losses;
        summary.partials += entry.playSummary.partials;
        summary.missed += entry.playSummary.missed;
        return summary;
      },
      {
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
      }
    );

    res.json({
      generatedAt: new Date().toISOString(),
      stats,
      entries: enriched,
    });
  } catch {
    res.status(500).json({ error: "Failed to load trade journal" });
  }
});
