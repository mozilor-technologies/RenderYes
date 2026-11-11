---
"@renderyes/server": patch
---

System One reads a declared value list of up to 200 values
(`SYSTEM_ONE_MAX_DECLARED_VALUES`, exported), where it read at most 32. A
field, a list field's `items` or an argument whose `enum` held 33 or more
values gave the fast path no words at all: on a catalog declaring 43 regions,
"visitors in Germany" was answered with every row and "Germany and
California" was refused as a compound prompt. Both now filter by the declared
values.

Two kinds of list are still not read, in whole or in part, and behave as a
field with no declared values does: a list longer than 200 values, and a list
of more than 32 codes (most of its values a single run of at most three
letters or digits, as ISO language, currency and state codes are), because
"show it as a table" is not a request for Italian. A list of 32 values or
fewer is read whatever it holds, as before.

Nothing a model is shown changes. The decision endpoint still receives ids and
purpose lines only, and the language-model contract still lists a scalar
field's `allowedValues` only up to 32.
