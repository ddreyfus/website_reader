Read the uploaded {{publication}} issue and produce a concise issue digest.

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

Read the Markdown directly where possible. Use Python only when necessary to access or process the file. Do not narrate routine file inspection or reproduce code, parsing output, raw tool responses, or intermediate data; present findings and citations.

## Comparison with the reading archive

Assume that material in my local reading archive has been read. Use **Website Reader Local** to determine what, if anything, each current item adds to that prior reading.

For each substantive item, **first assess the item entirely from its own evidence**. Only then compare its **substantive contribution** with the archive. Archived material must not fill gaps in the item's evidence or change what you attribute to its author.

Use the item's main claim or your concise summary of it to construct one or more focused archive searches. Search for prior material addressing substantially the same idea, evidence, event, or argument. **Exclude the current item and copies of it from the comparison.**

Inspect sufficiently promising retrieved material to determine whether the current item materially adds anything. Do not attempt to prove exhaustively that an idea is absent from the archive.

Classify the result as:

- **NEW** — No substantively relevant prior material was retrieved. Treat the item as new to the archive for purposes of this digest.
- **ADDS:** *what is new* — Prior material covers part of the subject, but the current item adds a materially new claim, argument, development, evidence, mechanism, implication, or conclusion. State the increment precisely.
- **REPEAT** — Retrieved prior material already contains the substantive contribution of the current item. State briefly what prior material covers it; do not repeat the full summary.

A shared topic is not enough to call something a repeat. Compare the **substantive contribution**. For example, if the archive already establishes that AI may reduce labour demand, an article arguing that this will erode payroll- and income-tax revenues adds a distinct fiscal implication.

When useful, link to the archived material supporting an **ADDS** or **REPEAT** judgment.

Archive retrieval is a practical familiarity test, not evidence about originality in the world. Therefore **NEW means only that no relevant archive match was retrieved**.

If the archive tools are unavailable, say the comparison could not be completed rather than classifying the item as NEW.

## Summaries

Begin with a tight **Summary** of the article. **Two sentences or fewer should be the default; do not use five sentences merely because five are allowed.**

Keep the tight summary first. **When the source develops a substantial argument whose reasoning would be lost in that summary, add a separate, longer “Argument” account.** Explain the central thesis, the main premises and steps connecting them to the conclusion, the evidence or examples doing real work, consequential assumptions, and any important counterarguments the source addresses. Make the argument understandable without requiring the reader to reconstruct it from the short summary. Distinguish the author's reasoning from your assessment of its strengths and gaps.

Use judgment: length, topic, or an opinion label alone does not warrant expansion. Add the longer account when the reasoning is substantive and its structure matters to understanding or evaluating the story; omit it for routine reporting, thin assertions, or repetition of the short summary. Use as much space as the argument warrants, usually one or a few focused paragraphs. The sentence limits for the tight summary do not apply to this separate account. Reconstruct only reasoning supported by the available source; do not invent missing premises or treat an email teaser as the full article's argument.

For the tight summary, identify the article's **question → conclusion → evidence that establishes it → important residual uncertainty**. Keep this sequence explicit but compact; if an element is absent, say so rather than supplying it from outside the article. For straightforward reporting, the “question” may be the event or development being reported, and the sequence may fit in one sentence.

- **News/reporting:** Usually one sentence. State what happened and, where important, why it matters. Use two sentences only when necessary.
{{publicationSpecificNewsGuidance}}
- **Analysis, features, science and economics:** Up to five sentences when the argument genuinely requires it. Identify the central claim or conclusion, reasoning, strongest evidence, and important qualifications or uncertainty.
{{publicationSpecificOpinionGuidance}}
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

Use the archive comparison to prioritize articles that add ideas or evidence beyond archived material, and identify those that largely repeat it.

Cross-article comparison and synthesis belong here, **not in the individual article-analysis stage**.

The result should be an efficient map of the issue, not a collection of miniature book reports.
