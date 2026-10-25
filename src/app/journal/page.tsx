import { Card, Empty } from "@/components/ui";

export default function Journal() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Journal</h1>
        <p className="mt-1 text-sm text-muted">Every closed trade, its R result, and whether the rules were followed.</p>
      </div>
      <Card>
        <Empty>Nothing to review yet. The journal fills in automatically once trades close.</Empty>
      </Card>
    </div>
  );
}
