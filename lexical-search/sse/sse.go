package sse

import (
	"text/template"
)

// Event represents the structure of the SSE message
type Event struct {
	SSEName string
	SSEData string
}

// Server Sent Event template
var EventTemplate = template.Must(template.New("event").Parse(
	"event: {{.SSEName}}\ndata: {{.SSEData}}\n\n",
))

type UpdateSummaryPayload struct {
	NumFiles int `json:"num_files"`
	NumDocs  int `json:"num_docs"`
}
