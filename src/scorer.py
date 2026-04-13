"""MuSiQue QA scorer — called as subprocess from evaluate.ts.

Reads JSON array of {prediction, answer, answer_aliases} on stdin.
Writes JSON array of {f1, em} to stdout.

Uses SQuAD-style scoring (same as MuSiQue's evaluate_v1.0.py).
Takes max F1/EM over answer + answer_aliases.
"""

import json
import re
import string
import sys
from collections import Counter


def normalize_answer(s):
    """Lower text and remove punctuation, articles, and extra whitespace."""
    s = s.replace(",", "")

    def remove_articles(text):
        return re.sub(r"\b(a|an|the)\b", " ", text)

    def white_space_fix(text):
        return " ".join(text.split())

    def remove_punc(text):
        exclude = set(string.punctuation)
        return "".join(ch for ch in text if ch not in exclude)

    def lower(text):
        return text.lower()

    return white_space_fix(remove_articles(remove_punc(lower(s))))


def exact_match_score(prediction, ground_truth):
    return normalize_answer(prediction) == normalize_answer(ground_truth)


def f1_score(prediction, ground_truth):
    prediction_tokens = normalize_answer(prediction).split()
    ground_truth_tokens = normalize_answer(ground_truth).split()
    common = Counter(prediction_tokens) & Counter(ground_truth_tokens)
    num_same = sum(common.values())
    if num_same == 0:
        return 0
    precision = 1.0 * num_same / len(prediction_tokens)
    recall = 1.0 * num_same / len(ground_truth_tokens)
    f1 = (2 * precision * recall) / (precision + recall)
    return f1


def metric_max_over_ground_truths(metric_fn, prediction, ground_truths):
    """Take max score over all valid ground truth answers."""
    return max(metric_fn(prediction, gt) for gt in ground_truths)


def score_qa(prediction, answer, answer_aliases):
    ground_truths = [answer] + (answer_aliases or [])
    ground_truths = [gt for gt in ground_truths if gt.strip()]
    if not ground_truths:
        ground_truths = [answer]

    f1 = metric_max_over_ground_truths(f1_score, prediction, ground_truths)
    em = 1.0 if metric_max_over_ground_truths(exact_match_score, prediction, ground_truths) else 0.0
    return {"f1": round(f1, 6), "em": em}


def main():
    items = json.loads(sys.stdin.read())
    results = []
    for item in items:
        result = score_qa(
            str(item["prediction"]),
            str(item["answer"]),
            item.get("answer_aliases", []),
        )
        results.append(result)
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
