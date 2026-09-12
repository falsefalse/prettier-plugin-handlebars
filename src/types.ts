import type { SourceRange } from './core/source';

export type { SourceRange } from './core/source';

export type Node =
  | Program
  | ElementNode
  | TextNode
  | MustacheStatement
  | BlockStatement
  | PartialStatement
  | DecoratorStatement
  | CommentStatement
  | UnmatchedNode;

export interface Program extends SourceRange {
  type: 'Program';
  body: Node[];
}

export interface AttributeValue extends SourceRange {
  type: 'AttributeValue';
  parts: AttributeValuePart[];
  /** The value between the quotes, verbatim. Quotes inside a mustache get printed too. */
  raw: string;
}

/** Everything that can stand in attribute position, or inside a value alongside its text. */
export type AttributeBlockNode =
  | MustacheStatement
  | BlockStatement
  | PartialStatement
  | DecoratorStatement
  | CommentStatement;

export type AttributeValuePart = TextNode | AttributeBlockNode;

/**
 * `glued` marks an attribute the author wrote with no space before it. For a mustache or block in
 * attribute position that space renders, so the printer may not invent one.
 */
export type ElementAttribute = SourceRange & { glued?: boolean } & (
  | {
      type: 'Attribute';
      name: string;
      /** Always present, `null` for a bare attribute: one spelling for absent, not two. */
      value: AttributeValue | null;
    }
  | {
      type: 'RawAttribute';
      raw: string;
    }
  | {
      type: 'AttributeBlock';
      block: AttributeBlockNode;
    }
);

export interface ElementNode extends SourceRange {
  type: 'ElementNode';
  tag: string;
  attributes: ElementAttribute[];
  children: Node[];
  selfClosing: boolean;
  /** As on `TextNode`: inside a value the printer may not break the tag, every character renders. */
  preserveWhitespace?: boolean;
  /** Set only when the author spelled the closing tag differently; HTML tag names ignore case. */
  closeTag?: string;
  /** Span between the tag name and the closing `>`, so the attributes can be checked to cover it. */
  attributesRange?: [number, number];
  /** Span between the open tag's `>` and the close tag's `<`, so children can be checked to tile it. */
  contentRange?: [number, number];
}

export interface TextNode extends SourceRange {
  type: 'TextNode';
  /** The source run, verbatim. Whitespace is content, never metadata. */
  chars: string;
  /** Content copied through untouched: raw-text elements, prettier-ignore regions. */
  verbatim?: boolean;
  /** Inside an attribute value, where every space renders and none of them are the printer's. */
  preserveWhitespace?: boolean;
}

/* Expressions print from their own `source`, never from a reconstructed value: Handlebars' own
 * AST loses the brackets in `a.[b c].d`, the quote character in `'x'` and the trailing zero in
 * `1.50`, all of which a formatter has to reproduce exactly. Structure exists to decide where to
 * break, not to rewrite what the author wrote. */
export type Expression = PathExpression | Literal | SubExpression;

export type LiteralType =
  | 'StringLiteral'
  | 'NumberLiteral'
  | 'BooleanLiteral'
  | 'NullLiteral'
  | 'UndefinedLiteral';

export interface PathExpression extends SourceRange {
  type: 'PathExpression';
  /** `a.[b c].d`, `../../x`, `@index`, `this`, exactly as written. */
  source: string;
}

export interface Literal extends SourceRange {
  type: LiteralType;
  /** Exactly as written, quotes included. */
  source: string;
}

export interface SubExpression extends SourceRange {
  type: 'SubExpression';
  /** `(concat 'p' x)` including the parens, so every expression node prints from itself. */
  source: string;
  path: PathExpression | SubExpression;
  params: Expression[];
  hash: HashPair[];
}

export interface HashPair extends SourceRange {
  /** Always a bare identifier: Handlebars rejects `a.b=1`. */
  key: string;
  value: Expression;
}

interface MustacheBase {
  /** A SubExpression head is only reachable through a dynamic partial, `{{> (lookup . "n")}}`. */
  path: PathExpression | SubExpression;
  params: Expression[];
  hash: HashPair[];
  blockParams?: string[];
  trimOpen?: boolean;
  trimClose?: boolean;
}

/** The parts every call shares: a mustache, a block marker, a partial, a subexpression. */
export type Call = Pick<MustacheBase, 'path' | 'params' | 'hash' | 'blockParams'>;

export interface MustacheStatement extends MustacheBase, SourceRange {
  type: 'MustacheStatement';
  triple: boolean;
}

export interface ElseBranch extends MustacheBase, SourceRange {
  type: 'ElseBranch';
  program: Program;
}

export interface BlockStatement extends MustacheBase, SourceRange {
  type: 'BlockStatement';
  program: Program;
  inverseChain?: ElseBranch[];
  inverse: Program;
  inverseTrimOpen?: boolean;
  inverseTrimClose?: boolean;
  blockPrefix?: '#' | '#>' | '#*' | '^' | '<' | '$';
  closeTrimOpen?: boolean;
  closeTrimClose?: boolean;
}

export interface PartialStatement extends MustacheBase, SourceRange {
  type: 'PartialStatement';
}

export interface DecoratorStatement extends MustacheBase, SourceRange {
  type: 'DecoratorStatement';
}

export interface CommentStatement extends SourceRange {
  type: 'CommentStatement';
  value: string;
  multiline: boolean;
  block: boolean;
  /** express-hbs' `{{!< name}}` layout directive, which must not be padded into prose. */
  layout?: boolean;
  trimOpen?: boolean;
  trimClose?: boolean;
}

export interface UnmatchedNode extends SourceRange {
  type: 'UnmatchedNode';
  raw: string;
  /** As on `TextNode`: in a value the trailing gap is content, not somewhere to break. */
  preserveWhitespace?: boolean;
}

export type ParseEndReason = 'blockEnd' | 'else' | 'tagClose' | null;
