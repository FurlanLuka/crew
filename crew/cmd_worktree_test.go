package main

import (
	"strings"
	"testing"
)

func TestBindingValue(t *testing.T) {
	tests := []struct {
		name                   string
		url, host, port, value string
		want, wantErr          string
	}{
		{name: "url shorthand", url: "speak-api", want: "{{speak-api}}"},
		{name: "url with server", url: "mumbo/backend", want: "{{mumbo/backend}}"},
		{name: "host shorthand", host: "livekit", want: "{{livekit.host}}"},
		{name: "port with server", port: "mumbo/backend", want: "{{mumbo/backend.port}}"},
		{name: "value verbatim", value: "ws://{{livekit.host}}/rtc", want: "ws://{{livekit.host}}/rtc"},
		{name: "nothing given", wantErr: "give one of"},
		{name: "two given", url: "a", port: "b", wantErr: "give one of"},
		{name: "bad target", url: "a/b/c", wantErr: "--url=a/b/c: expected project or project/server"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := bindingValue(tt.url, tt.host, tt.port, tt.value)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("bindingValue: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
