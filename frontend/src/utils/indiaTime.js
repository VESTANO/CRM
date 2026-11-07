const parts = (date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(date).map(({type,value})=>[type,value]));
export function indiaDateTimeInput(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export const indiaDateInput = (date = new Date()) => indiaDateTimeInput(date).slice(0,10);
export const indiaInputTimestamp = value => new Date(`${value}:00+05:30`).toISOString();
