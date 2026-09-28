Read the uploaded Economist issue and produce a concise issue digest.

The purpose is to tell me what each article says, what it actually establishes, and which articles may warrant closer reading.

## Processing method

Treat the uploaded issue as the source repository. **Do not try to reason over the entire issue at once.**

Work through it sequentially, **one section and one article at a time**. Use file retrieval/read operations as needed to bring the relevant article or bounded portion of the issue into working context.

**Before summarizing, inventory the sections and content units actually present in the Markdown. After processing, reconcile the output against that inventory and verify that every substantive section/article/news item has either been summarized, deliberately skipped under the stated rules, or marked unsupported. Do not infer absence from the table of contents alone.**

For each article:

1. Locate and read that article as a discrete unit.
2. Analyze it before proceeding to the next article.
3. During that analysis, use **only that article** as evidence.
4. Do not use previous summaries, impressions from earlier articles, or other articles in the issue to fill gaps or influence the assessment.
5. Record the summary, then proceed to the next article.

The purpose of this procedure is to minimize context drift, cross-article contamination, and degradation from attempting to process the entire issue simultaneously.

Do not delegate article processing to an external workflow or require separate API calls. The uploaded issue remains the artifact; retrieval, iteration, analysis, and synthesis should occur within ChatGPT.

Preserve the issue's section order and article order.

## Summaries

Use the shortest summary that adequately captures the article. **Two sentences or fewer should be the default; do not use five sentences merely because five are allowed.**

For every summary, identify the article's **question → conclusion → evidence that establishes it → important residual uncertainty**. Keep this sequence explicit but compact; if an element is absent, say so rather than supplying it from outside the article. For straightforward reporting, the “question” may be the event or development being reported, and the sequence may fit in one sentence.

- **News/reporting:** Usually one sentence. State what happened and, where important, why it matters. Use two sentences only when necessary.
- **The World This Week:** Treat Politics and Business as collections of discrete news items. Summarize each item in one sentence unless a second sentence is necessary.
- **Analysis, features, science and economics:** Up to five sentences when the argument genuinely requires it. Identify the central claim or conclusion, reasoning, strongest evidence, and important qualifications or uncertainty.
- **Leaders, columns and opinion:** Up to five sentences. Clearly distinguish the article's claim from the evidence offered for it. Identify significant assumptions, missing evidence, acknowledged counterevidence, or material gaps between evidence and conclusion.
- **Letters:** Skip unless they contain a substantive argument or evidence worth noting.
- **Unsupported or missing articles:** Identify them as unavailable. Do not infer their contents from titles, related articles, general knowledge, or other material in the issue.

Do not paraphrase an article sequentially. Compress it to its informational or argumentative core.

## Claims and evidence

Where useful, explicitly label **Claim**, **Evidence**, and **Weak point**. Do not force those labels onto straightforward reporting.

**Judge the evidence, not the rhetoric.**

Distinguish:

- what the evidence directly establishes;
- what the author reasonably infers from it;
- what remains speculation, prediction, analogy, causal inference, or opinion.

Do not assume a claim is established merely because the article states it confidently. Conversely, do not manufacture objections merely to provide balance.

Pay particular attention to:

- causal claims supported only by correlations;
- plausible counterfactuals or alternative causal explanations that the article does not test;
- critical assumptions on which the conclusion depends but which the article leaves untested;
- ideological, institutional, selection, or framing bias substituting for analysis or determining which evidence is considered;
- projections presented as conclusions;
- anecdotes standing in for broader evidence;
- cherry-picked cases, time periods, comparisons, or benchmarks, including neglected base rates;
- evidence that establishes direction but not magnitude;
- claims whose strongest evidence is omitted;
- claims framed so vaguely or flexibly that contrary evidence could not meaningfully disconfirm them;
- conclusions substantially stronger than the evidence presented.

When one of these issues is material, identify it and explain briefly how it limits the conclusion. Distinguish a genuinely plausible alternative explanation from a merely imaginable one, and identify bias only when the article's framing or use of evidence supports that assessment. If the evidence adequately supports the conclusion, simply say so or summarize it without inventing a “weak point.”

## Source discipline

Stay grounded in the uploaded issue.

Do not silently supplement an article with outside knowledge or information from another article. If the article does not provide enough evidence to assess a claim, say so rather than filling the gap yourself.

Do not fact-check against outside sources unless I explicitly ask you to.

## Final synthesis

Only **after every article has been processed individually**, consider the issue as a whole.

Add a short section identifying articles that appear particularly worth closer reading because of, for example:

- a consequential or non-obvious claim;
- unusually strong evidence;
- an interesting gap between claim and evidence;
- genuine uncertainty;
- an argument that would benefit from closer examination.

Cross-article comparison and synthesis belong here, **not in the individual article-analysis stage**.

The result should be an efficient map of the issue, not a collection of miniature book reports.
