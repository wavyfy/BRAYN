const TRIGGER_LABELS: Record<string, string> = {
  'revenue_opportunity.created': 'Revenue opportunity created',
  'customer_health.recalculated': 'Customer health recalculated',
};

function humanize(value: string): string {
  const words = value.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Display label for an automation trigger — the same wording the create form offers. */
export function triggerLabel(triggerType: string): string {
  return TRIGGER_LABELS[triggerType] ?? humanize(triggerType);
}

export function actionLabel(actionType: string): string {
  return humanize(actionType);
}
