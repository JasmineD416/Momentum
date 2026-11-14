// Daily inspiration: one quote per New York business date, the same for everyone.
// Placeholder bank written for this rebuild; replace with the approved Momentum quotes when available.
export const QUOTES = [
  'Bold ambition creates limitless possibility.', 'Momentum is built one deliberate step at a time.', 'Small wins, repeated daily, become big results.',
  'Clarity first. Speed follows.', 'Make the hard call before lunch.', 'Every follow-up is a promise kept.', 'Consistency outworks talent that rests.',
  'Lead with care; close with confidence.', 'Progress loves a plan and a deadline.', 'Make it simple, then make it happen.', 'Your next client is one conversation away.',
  'Ambition is a decision you make every morning.', 'Done well beats done perfectly.', 'Be the reason someone’s day gets easier.', 'Great teams share the load and the credit.',
  'Start before you feel ready.', 'Details build trust.', 'Focus means saying no to the good for the great.', 'Energy is contagious. Bring yours.',
  'Momentum favours the prepared.', 'Turn every no into a next step.', 'Show up, follow through, lift others.', 'Big goals need small daily rituals.',
  'The best time to follow up is now.', 'Confidence comes from doing the work.', 'Courage is the first line item of growth.', 'Excellence is a habit, not an event.',
  'Write it down. Then get it done.', 'Momentum is a team sport.', 'Finish strong; tomorrow starts tonight.', 'Keep going. You are closer than you think.',
];
export function quoteFor(businessDate: string) {
  const days = Math.floor(Date.parse(businessDate + 'T00:00:00Z') / 86_400_000);
  return QUOTES[((days % QUOTES.length) + QUOTES.length) % QUOTES.length];
}
