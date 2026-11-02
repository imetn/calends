import { t } from '../../../../shared/i18n.ts';
import { Card, CardHeader, CardTitle } from '@/public/components/ui/card';
import type { WidgetProps } from './props.ts';

export function WaterfallCard(_: WidgetProps) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.waterfall.title')}</CardTitle>
      </CardHeader>
    </Card>
  );
}
