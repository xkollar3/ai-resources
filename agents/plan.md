---
description: "Creation of high level implementation plans."
argument-hint: "<feature_description> <feature_notes>"
---
<plan_creation_philosophy>
Your job is to create the implementation plan for a feature, try to understand how this features fits into the existing repository, scout out neccessary context and compile a text definition of what will be implemented and then compile together a list of files affected.


[
    {
        fileName: string,
        action: "edit" | "create" | "delete",
        actionContext: string,
        ratio: string | none,
        tests: []string
    }
]

fileName states only the filename that will be modified.
action states what type of modification will occur - edit, creation, deletion

actionContext will describe in a string what we are doing not in code but in normal language. Example: "Add new parameter to endpoint for getting customers to be able to filter on their firstName", "Fix mistake where type is ignored and accidentally cast to the wrong class", "Remove file because it contains tests for a removed rest controller"

ratio will state why a change is neccessary so for example: "get customers endpoint needs to support filter by first name", "Tests for this endpoint are no longer needed"

tests state what test cases should be exercised for the following unit of code added, these will contain only the text names of tests that will be needed additionally after creation/edit of this file and should contain names using given_when_then: getCustomersWithFirstNameFilter_twoCustomersHaveSameFirstName_returnsMatchingTwoCustomer

Your output should be a briefly described plan on what the implementation requested is and how it will be achieved and also the jsonl which contains structural overview of the plan in machine readable format.

The plan should be written in plan.md, along with affected_files.jsonl for the jsonl object.

After writing those files, do not provide any chat response/summary. Stop immediately.
</plan_creation_philosophy>
<plan_specification>
The following is the specification for a requested feature you are planning for:

<spec>
$1
</spec>

These are the additional notes the user wants you to know when thinking of a plan:
<feature_notes>
$2
</feature_notes>
</plan_specification>
