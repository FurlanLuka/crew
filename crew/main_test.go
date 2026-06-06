package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestExtractFlag(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		flag     string
		wantArgs []string
		wantHit  bool
	}{
		{
			name:     "absent",
			args:     []string{"crew", "ls", "workspaces"},
			flag:     "--json",
			wantArgs: []string{"crew", "ls", "workspaces"},
			wantHit:  false,
		},
		{
			name:     "present trailing",
			args:     []string{"crew", "ls", "workspaces", "--json"},
			flag:     "--json",
			wantArgs: []string{"crew", "ls", "workspaces"},
			wantHit:  true,
		},
		{
			name:     "present leading",
			args:     []string{"crew", "--json", "ls", "workspaces"},
			flag:     "--json",
			wantArgs: []string{"crew", "ls", "workspaces"},
			wantHit:  true,
		},
		{
			name:     "repeated",
			args:     []string{"crew", "--json", "show", "ws", "--json"},
			flag:     "--json",
			wantArgs: []string{"crew", "show", "ws"},
			wantHit:  true,
		},
		{
			name:     "only binary",
			args:     []string{"crew"},
			flag:     "--json",
			wantArgs: []string{"crew"},
			wantHit:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotArgs, gotHit := extractFlag(tt.args, tt.flag)
			if gotHit != tt.wantHit {
				t.Errorf("hit = %v, want %v", gotHit, tt.wantHit)
			}
			if !reflect.DeepEqual(gotArgs, tt.wantArgs) {
				t.Errorf("args = %v, want %v", gotArgs, tt.wantArgs)
			}
		})
	}
}

// TestEmptySliceMarshalsToArray documents why JSON branches must initialize
// output slices as []T{} rather than a nil var: a nil slice marshals to "null",
// an empty non-nil slice to "[]". Consumers expect an array, so [] is required.
func TestEmptySliceMarshalsToArray(t *testing.T) {
	var nilSlice []int
	nilData, _ := json.Marshal(nilSlice)
	if string(nilData) != "null" {
		t.Errorf("nil slice marshaled to %q, want \"null\"", nilData)
	}

	emptySlice := []int{}
	emptyData, _ := json.Marshal(emptySlice)
	if string(emptyData) != "[]" {
		t.Errorf("empty slice marshaled to %q, want \"[]\"", emptyData)
	}
}
