import { Card, Empty } from "@/components/ui";

export default function Positions() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
        <p className="mt-1 text-sm text-muted">Open trades, pending entries, and stop changes.</p>
      </div>
      <Card>
        <Empty>No positions yet. Order placement and position management arrive in milestones 3 and 4.</Empty>
      </Card>
    </div>
  );
}
