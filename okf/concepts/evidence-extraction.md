# Evidence extraction

`packages/runtime/src/extractor.ts` · `evidence-schema.ts` · `keyword-extractor.ts`

**The evidence block IS a JSON Schema.** That is why a declarative contract works where a
prompt cannot: the API guarantees conformance rather than the prompt requesting it.

Every field is `required` with a nullable value rather than optional, so the model must
explicitly report "not established" instead of silently omitting.

Returned fields are filtered: non-null, and at or above the field's `confidence_min`.
Everything else is simply absent, and the runtime reads absence as "still to collect".

## The offline pair

`KeywordExtractor` + `offlineClient` make the whole pipeline runnable with no credential —
for CI, for local work, and as proof that extraction is swappable behind its interface.

It normalises both sides before matching, because `executive_mba` never matched someone
typing "the Executive MBA" and the offline agent looked broken to anyone typing like a
person. A contiguous phrase scores 0.95, scattered words 0.8. It cannot infer: "I decide
myself" does not yield `self`, and the UI says so.

`evidenceToZod` lives in `runtime`, not `core`, on purpose: core stays ignorant of which
provider is behind `step()`.

Related: [agent runtime](agent-runtime.md) · [journey spec](journey-spec.md)
