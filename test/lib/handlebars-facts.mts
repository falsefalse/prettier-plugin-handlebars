/* What a template says, according to Handlebars itself. Two gates ask this - the render oracle,
 * to build partials that echo what they were handed, and the format gate, to check that
 * re-quoting a literal did not change what it holds - and both want the real answer, not a
 * restatement of Handlebars' escaping rule that could be wrong in the same direction twice. */
import Handlebars from 'handlebars';

export interface TemplateFacts {
  /** In document order, duplicates kept: the format gate compares two of these positionally. */
  literals: string[];
  hashKeys: string[];
}

/* Handlebars' own visitor knows the shape of its own tree, so this states which nodes matter
 * rather than how to reach them. `Hash` still calls up, or the pairs' values go unvisited and a
 * literal written inside one is missed. */
class FactsVisitor extends Handlebars.Visitor {
  readonly literals: string[] = [];
  readonly hashKeys: string[] = [];

  override StringLiteral(node: hbs.AST.StringLiteral): void {
    this.literals.push(node.value);
  }

  override Hash(hash: hbs.AST.Hash): void {
    for (const pair of hash.pairs) this.hashKeys.push(pair.key);

    super.Hash(hash);
  }
}

/**
 * `null` for a source Handlebars cannot parse, so a caller has to say what that means rather
 * than reading empty facts as "nothing changed" - which is how a gate goes vacuous unnoticed.
 */
export function templateFacts(source: string): TemplateFacts | null {
  const visitor = new FactsVisitor();

  try {
    visitor.accept(Handlebars.parse(source));
  } catch {
    return null;
  }

  return { literals: visitor.literals, hashKeys: visitor.hashKeys };
}
