import type { InfrastructureSizeTier } from '@deployz/contracts';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { sizeTierCompute, sizeTierLabel } from '@/lib/size-tiers';

/** One select over deployment sizes, each option with its compute. */
export function SizeSelect({
  id,
  value,
  tiers,
  onValueChange,
  disabled = false,
}: {
  id: string;
  value: InfrastructureSizeTier;
  tiers: readonly InfrastructureSizeTier[];
  onValueChange: (tier: InfrastructureSizeTier) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as InfrastructureSizeTier)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {tiers.map((tier) => (
          <SelectItem key={tier} value={tier}>
            {sizeTierLabel(tier)} ({sizeTierCompute(tier)})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
