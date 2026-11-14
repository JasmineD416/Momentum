import { useEffect, useState } from 'react';

/** Hash routes like #/clients/abc → ['clients', 'abc']. */
export function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => { setParts(read()); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return parts;
}
export const go = (path: string) => { location.hash = '#/' + path; };
export const href = (path: string) => '#/' + path;
