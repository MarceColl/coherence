# Scaffold

The command that makes the complete shape the cheapest thing to produce: a component with its intent, an invariant with every slot and its checklist.
model: none — it writes spec text from templates, and its refusal to overwrite is example-tested

## invariants
- every slot printed: A scaffolded invariant prints every slot its form takes as a placeholder (the entrances a totality oracle on a declared crossing covers among them, which a chokepoint form never names) and one checklist line per applicable shape, and nothing for a shape that does not apply.
  protects: PLACEHOLDERS
  chokepoint: renderInvariant
  over: every key of the grammar and every shape of the checklist seed
  via: scaffold invariant prints every slot and only the applicable checklist shapes
  because: the complete shape must be the cheapest thing to produce; if a slot were missing the agent would have to recall the grammar, and a shape that does not apply would be dismissed by rote, which is the unexamined gap the checklist exists to prevent; the placeholder text lives in one table read by one function
  crossing: reading -> project-source
  refuted: made renderInvariant skip the first applicable shape -> "scaffold invariant prints every slot and only the applicable checklist shapes" went red in scaffold.test.ts; restored, green (2026-09-17)
  kinds: none
- written bullet parses as a requirement: A bullet the scaffold writes lands in the invariants section and parses as a requirement with its unfilled slots listed.
  over: every bullet the scaffold appends to a spec
  via: scaffold invariant --write appends to the invariants section, and the result parses as a requirement with unfilled slots
  because: what is written first must still parse, or the agent would have to fill every slot in one sitting; a requirement with its unfilled slots listed is the honest state of a bullet written and not yet settled
  crossing: reading -> project-source
  refuted: made appendInvariant write the spec back without the bullet -> "scaffold invariant --write appends to the invariants section, and the result parses as a requirement with unfilled slots" went red in scaffold.test.ts; restored, green (2026-09-17)
  kinds: none
- a component lives under its project: The folder a component is scaffolded into is confined to the project root; one that reaches above it is refused and nothing is created.
  protects: confineToRoot
  chokepoint: src/scaffold/scaffold.ts
  over: every folder given to scaffold component and scaffold invariant, relative, absolute, and reaching upward
  via: scaffold confines a component folder to the project root
  because: the folder comes from a command line or from spec text an agent wrote, neither of which is trusted to stay inside the tree it names; a scaffold that followed one upward would write a spec into a neighbouring project, and the invariant verb would then read and append to it
  crossing: reading -> project-source
  refuted: resolved the folder against the root and made it, so "..", an absolute path and "src/../../up" each created a component above the project -> "scaffold confines a component folder to the project root" went red in scaffold.test.ts, no exception where one was expected; restored, green (2026-09-18)
  kinds: none
- no overwrite: Scaffolding a component creates the folder and its spec with the intent and an empty invariants section, and refuses to overwrite a spec that exists.
  over: every folder the scaffold is asked to make a component
  via: scaffold component creates the folder and a spec with the intent and an empty invariants section, and refuses to overwrite
  because: a spec is the settled claims of a component; a scaffold that replaced one with an empty section would delete every invariant in it in the name of convenience
  crossing: reading -> project-source
  refuted: relaxed the existing-spec check so one spec could be overwritten -> "scaffold component creates the folder and a spec with the intent and an empty invariants section, and refuses to overwrite" went red in scaffold.test.ts; restored, green (2026-09-17)
  kinds: revision
  checklist: revision-preservation declared as no overwrite
- preview is a proposal, not evidence: A scaffold preview writes a self-contained Scope page outside the project tree whose Structure view adds the declared crossing as a dashed, unverified proposal; it changes no spec unless write is explicit, and identical inputs produce identical page bytes.
  over: every scaffold invariant invocation with preview, with and without write, including invalid components, crossing syntax, trust levels, and markup-bearing names
  via: scaffold invariant --preview writes only an ephemeral proposed, dashed, unverified Structure edge
  because: a human needs to see the proposed vertebra in the existing security spine before accepting it, but rendering a possibility must not claim that the requirement was written, run, graded, or evidenced; keeping generated output outside the adopter tree also prevents the reading from changing the lexicon population it reads
  crossing: project-source -> reading
  refuted: inverted the preview branch so a preview request only printed the bullet and wrote no page -> the focused scaffold preview detector failed because no preview path was printed; restored, green (2026-09-18)
  kinds: none
- a gap's closure is proposed: For each entrance with no traced control the scaffold proposes a ranked closure in the spec's terms: the exact guard: line where its handler calls or passes a verified chokepoint its route-mates do not, else an invariant bullet in the scaffold shape whose crossing enters from its trust and whose entrances: line names it, and control: none first where it plausibly needs none.
  over: a handler calling a verified chokepoint, one the reading traced passing it while a route-mate does not, one whose reach meets no control, and a health check reaching no component beyond its own
  via: scaffold control proposes each gap's closure: a guard: line where its handler calls or passes a verified chokepoint its route-mates do not, else an invariant whose crossing enters from its trust, and control: none first where it plausibly needs none
  because: both outside adoptions left their gaps open (d-a1095ef2); the closure must be the cheapest thing to write, printed from what the reading already knows, not recalled from the grammar
  crossing: record -> reading
  refuted: stopped reading which verified chokepoint symbol a handler's declaration calls, so no guard: line was proposed for it -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- a lost control is named back: For an entrance with no traced control that a verified invariant covered by its crossing alone, scaffold control proposes first the entrances: line naming it on that invariant, the name plain where it resolves from the invariant's spec and qualified by folder where not; --all groups those entrances under the invariant on one line; --write puts the line beneath the invariant's crossing, or adds the name to the line it has, never twice; and the named entrance's route is controlled again.
  over: praetorium.gg's shape with the signature check unnamed: the notification route's proposal, its words, the grouped --all line, the write, the route after it, and the server function named on the server's own invariant, twice
  via: scaffold control proposes the entrances: line first for an entrance a verified invariant covered by its crossing alone, writes it beneath the crossing or adds to the line, and the named entrance's route is controlled again
  because: the migration off the crossing-alone credit must cost one line per invariant, printed from what the reading knows; an adopter left to find which invariant used to cover which route would baseline the new gaps instead of naming what the tests check
  crossing: record -> reading
  refuted: dropped the entrances: closure from proposeClosures, so a lost control was proposed back as a new invariant -> the totality oracle went red; restored, green (2026-10-08)
  kinds: none
- a closure is written only where safe: The scaffold writes a guard: line under the entrance's bullet, never a second one nor one beside control: none; control: none only with a real reason, never a placeholder; and an invariant bullet as a requirement with its placeholders; what it writes still parses.
  over: a guard: written, written again, a control: none without a reason, with a placeholder reason, with a reason, beside a guard, and an invariant appended
  via: scaffold control writes only where safe: a guard: line under the entrance's bullet, never twice nor beside control: none; control: none only with a real reason; an invariant as a requirement with its placeholders
  because: a waiver without a reason is a silent one, and a guard beside control: none contradicts itself; a write that left the spec unparseable would cost more than it saved
  crossing: project-source -> reading
  refuted: let writeClosure write control: none without a reason or with a placeholder one -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- scaffold control reads the recorded reading: The scaffold control command proposes from the recorded Structure reading while it describes the tree, reading only when it does not, and prints one entrance's closure or every gap's, writes on --write, and records the adoption baseline on --baseline.
  over: one entrance, a control: none written and read back without a new reading, every gap, an unknown entrance, and the baseline
  via: the scaffold control command reads the recorded reading, prints one entrance's closure or every gap's, writes on --write, and records the adoption baseline
  because: a reading takes minutes on a large project; a closure the agent writes one entrance at a time must not cost a reading each, and a spec line the reading never reads leaves it standing
  crossing: record -> reading
  refuted: made the control verb ignore the recorded reading and read the component interfaces every time -> the totality oracle went red; restored, green (2026-09-25)
  kinds: none
- undeclared entrances are proposed in the spec grammar: For every detected entrance no declared entrance covers, scaffold entrances prints one ## entrances bullet in the spec grammar under the spec of the component whose folder holds its file, named apart from that spec's entrances, its handler resolving to that entrance, and its meaning and trust as placeholders, the trust listing the entry spec's levels; filled and pasted where it says, each bullet parses and covers the entrance it was proposed for; it never writes.
  over: the undeclared server functions, server route and package script of a project with a component of its own for its server functions, pasted with the meaning and trust filled, and the specs before and after the command
  via: scaffold entrances proposes a bullet in the spec grammar for every undeclared entrance, under the spec of the component owning its file, that covers it once its meaning and trust are filled, and writes nothing
  because: c-9941b95e: coverage stayed at 11 to 14 percent on praetorium.gg in both arms of the replicated A/B, about 100 server functions and routes never declared; declaring one by hand means recalling the grammar and how the spec resolves a handler, so the complete bullet must be the cheapest thing to write. Only the agent knows what work enters and whose trust it carries, so those stay placeholders and nothing is written, as control: none is never written with a placeholder reason
  crossing: project-source -> reading
  refuted: proposed every symbol handler as a bare name, dropping in <file>, in entranceHandler -> the totality oracle went red; restored, green (2026-09-28)
  kinds: none
- a Next.js app's entrances are proposed and resolve: On a Next.js app shaped like ai-chatbot, scaffold entrances proposes the request proxy, the GET and POST its NextAuth route file re-exports, and each page route, a page named by its route path and handled by its module file, under the spec of the component holding each file, even a component in a (group) folder; filled and pasted, every bullet resolves and covers its entrance.
  over: proxy.ts, the re-exported GET and POST of app/(auth)/api/auth/[...nextauth]/route.ts under app/(auth)/(auth).spec.md, and the pages app/(chat)/page.tsx and app/(chat)/chat/[id]/page.tsx, pasted with the meaning and trust filled
  via: scaffold entrances on a Next.js app shaped like ai-chatbot proposes the request proxy, the GET and POST its NextAuth route re-exports, and its page routes, and the filled bullets resolve and cover them
  because: a real adoption of ai-chatbot detected 21 entrances and missed 3 the agent declared by hand, and the handlers it wrote for them were refused (df-6cdc0504, df-0a67c462, df-a0e893af)
  crossing: project-source -> reading
  refuted: dropped the page route naming in entranceName, so every page was named page by its file stem -> "scaffold entrances on a Next.js app shaped like ai-chatbot proposes the request proxy, the GET and POST its NextAuth route re-exports, and its page routes, and the filled bullets resolve and cover them" went red in src/scaffold/entrances.test.ts; restored, green (2026-10-05)
  kinds: none
- scaffold control reads only what a named request needs: With no recorded reading of the tree, scaffold control for an entrance by name, or for every entrance --all --component declares, reads only the components their routes enter, says the reading was scoped and which components it read, and records nothing; --all alone and --whole read every component interface and record the reading, which a later request then reads without a new one.
  over: one entrance by name, a component's entrances, every entrance, the same entrance with --whole, and the same again after the whole reading was recorded, through the TypeScript adapter
  via: scaffold control on named entrances with no recorded reading reads only their routes' components, says so, and records nothing; --all alone and --whole read every one and record it
  because: on a large adopter the whole reading takes minutes, which asking about one entrance should not cost; the gaps orient and Stop read need every route, so only a whole reading is recorded
  crossing: record -> reading
  refuted: inverted the --whole test in controlVerb, so a named entrance was read whole and recorded and --whole read scoped -> "scaffold control on named entrances with no recorded reading reads only their routes' components, says so, and records nothing; --all alone and --whole read every one and record it" went red in control.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a boundary draft follows its declaration: scaffold import tach prints one draft spec per module tach.toml declares: the folder its dotted path names, an intent line carrying the product.yaml name and where the module was declared, an owners: line carrying the product.yaml owners, a totality oracle bullet listing its depends_on, and where an interface names it, a totality oracle bullet listing what it exposes and one chokepoint bullet per exposed path, that path as the chokepoint when it names a package, module file or symbol on disk, governing from outside the component as tach does; every slot only a human can fill stays a placeholder, and each draft names via: tests it prints on stderr, which run tach check once and keep one module's diagnostics.
  over: a synthetic tach.toml of three modules, one with a product.yaml and a layer, one utility, one depending on a module by an inline table, and one interface exposing a package and a pattern, drafted by name and with --all
  via: scaffold import tach drafts each module's spec from tach.toml: its folder, its intent, an owners: line from product.yaml, its declared dependencies, and a chokepoint per exposed path that governs from outside the component
  because: a repository that already declares its boundaries by machine, as PostHog's tach.toml does for 101 modules, should not pay an adopter to transcribe them; a draft that guessed a because or a protected internal would pass for a decision nobody made, so only what the declaration states is filled. tach checks only imports from other modules, so a facade draft that counted the module's own references would grade the boundary tach declares broken
  crossing: project-source -> reading
  refuted: dropped the product.yaml owners from the drafted intent line in renderDraft -> "scaffold import tach drafts each module's spec from tach.toml: its folder, its intent with the product.yaml owners, its declared dependencies, and a chokepoint per exposed path" went red in src/scaffold/import.test.ts; restored, green (2026-10-07)
  refuted: dropped from: outside the component from the drafted facade chokepoint bullets in renderDraft -> "scaffold import tach drafts each module's spec from tach.toml: its folder, its intent, an owners: line from product.yaml, its declared dependencies, and a chokepoint per exposed path that governs from outside the component" went red in import.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
- a boundary draft never overwrites: scaffold import tach --write creates a draft spec only where the module's folder exists and holds no spec, reports each module it skipped and why, and leaves every existing spec byte for byte; what it writes parses as a component.
  over: every module of the synthetic tach.toml with --all --write, one folder already holding a spec, and a second --write after a written draft was edited
  via: scaffold import tach --write creates only the specs that do not exist, reports each one skipped, and what it writes parses
  because: a spec is the settled claims of a component; drafting from a declaration is worth nothing if a rerun could replace what a human has filled since
  crossing: reading -> project-source
  refuted: made writeDrafts see no existing spec and open its file for overwrite -> "scaffold import tach --write creates only the specs that do not exist, reports each one skipped, and what it writes parses" went red in src/scaffold/import.test.ts; restored, green (2026-10-07)
  kinds: revision
  checklist: revision-preservation declared as a boundary draft never overwrites
- a boundary draft refuses what it cannot read: scaffold import tach refuses a malformed tach.toml naming the file and line, refuses a module the file does not declare, and in either case prints and writes no draft.
  over: an unquoted path value, an expose that is no array, an unknown module named beside a known one, no module named, and an unknown source
  via: scaffold import tach refuses a malformed tach.toml with its line, and an unknown module, and drafts nothing
  because: a draft read from a half-parsed file would declare boundaries the repository never declared; a misspelt module drafted as nothing would look like a module with no boundaries
  crossing: project-source -> reading
  refuted: let importVerb drop a module tach.toml does not declare instead of refusing it, drafting the known ones -> "scaffold import tach refuses a malformed tach.toml with its line, and an unknown module, and drafts nothing" went red in src/scaffold/import.test.ts; restored, green (2026-10-07)
  kinds: none
- scaffold control reads every language: scaffold control in a multi-language project proposes from a Structure reading of every language, says which languages it read, and reads each handler's declaration in its own file's language for the chokepoint it calls.
  over: an entrance in each language on a route with no traced control, with its chokepoint verified and not
  via: scaffold control on a two-language project reads both languages and proposes from each language's handlers
  because: its reading and its handler scan took the primary language alone, so a TypeScript handler's guard: line was never proposed and its route's gap was never read (df-f47a5c05)
  crossing: instrument -> reading
  refuted: made proposeClosures read every handler's declaration in the primary language -> "scaffold control on a two-language project reads both languages and proposes from each language's handlers" went red in multi-language.test.ts on its own assertion; restored byte for byte, green batched and alone (2026-10-07)
  kinds: none
