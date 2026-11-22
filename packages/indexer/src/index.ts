import type { Indexer } from "@forge/protocol";

export class EmptyIndexer implements Indexer {
  grep: Indexer["grep"] = async () => [];
  symbol: Indexer["symbol"] = async () => undefined;
  references: Indexer["references"] = async () => [];
  repoMap: Indexer["repoMap"] = async () => "";
}
