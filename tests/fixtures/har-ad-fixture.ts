import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdInput } from '../../src/domain/ad-input.js';

interface HarRoot {
  data: {
    ad_library_main: {
      search_results_connection: {
        edges: Array<{ node: { collated_results: AdInput[] } }>;
      };
    };
  };
}

export function loadHarAds(): AdInput[] {
  const harPath = fileURLToPath(new URL('./data/meta-ad-library-graphql-response.json', import.meta.url));
  const har = JSON.parse(readFileSync(harPath, 'utf8')) as HarRoot;
  return har.data.ad_library_main.search_results_connection.edges.flatMap(
    (edge) => edge.node.collated_results,
  );
}
