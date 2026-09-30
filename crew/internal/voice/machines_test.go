package voice

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func TestMachineIDFor(t *testing.T) {
	// One table for both sides: voiceos/src/shared/machines.spec.ts reads it too.
	data, err := os.ReadFile("testdata/machine-ids.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Host  string   `json:"host"`
		Taken []string `json:"taken"`
		ID    string   `json:"id"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := MachineIDFor(c.Host, c.Taken); got != c.ID {
			t.Errorf("MachineIDFor(%q, %v) = %q, want %q", c.Host, c.Taken, got, c.ID)
		}
	}
}

func TestValidHost(t *testing.T) {
	for _, host := range []string{"vm1", "dev@vm1.example.com", "build_box"} {
		if !ValidHost(host) {
			t.Errorf("%q should be a host", host)
		}
	}
	for _, host := range []string{"", "-oProxyCommand=touch", "vm1; rm -rf ~", "a b"} {
		if ValidHost(host) {
			t.Errorf("%q must be refused", host)
		}
	}
}

func TestMachinesAddRenameRemove(t *testing.T) {
	os.Remove(MachinesFile())
	t.Cleanup(func() { os.Remove(MachinesFile()) })

	added, err := AddMachine("dev@vm1.example.com", "Build box")
	if err != nil {
		t.Fatal(err)
	}
	if added != (Machine{ID: "vm1", Host: "dev@vm1.example.com", Name: "Build box"}) {
		t.Fatalf("added %+v", added)
	}
	if _, err := AddMachine("dev@vm1.example.com", ""); err == nil {
		t.Fatal("the same host twice must be refused")
	}
	second, err := AddMachine("vm1", "")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != "vm1-2" || second.Name != "vm1-2" {
		t.Fatalf("second %+v", second)
	}
	if err := RenameMachine("vm1", "GPU box"); err != nil {
		t.Fatal(err)
	}
	if err := RemoveMachine("vm1-2"); err != nil {
		t.Fatal(err)
	}
	if err := RemoveMachine("nope"); err == nil {
		t.Fatal("removing an unknown machine must fail")
	}
	got, err := ReadMachines()
	if err != nil {
		t.Fatal(err)
	}
	want := []Machine{{ID: "vm1", Host: "dev@vm1.example.com", Name: "GPU box"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMachineRows(t *testing.T) {
	machines := []Machine{{ID: "vm1", Host: "vm1", Name: "Build box"}, {ID: "gpu", Host: "gpu", Name: "gpu"}}
	var recorded recordedMachines
	recorded.Machines = map[string]struct {
		Status string `json:"status"`
		Detail string `json:"detail"`
	}{"vm1": {Status: "unreachable", Detail: "Host vm1 not found."}}

	running := machineRows(machines, recorded, true)
	if running[0].Status != "unreachable" || running[0].Detail != "Host vm1 not found." || running[1].Status != "connecting" {
		t.Fatalf("running rows %+v", running)
	}
	stopped := machineRows(machines, recorded, false)
	if stopped[0].Status != "stopped" || stopped[1].Status != "stopped" {
		t.Fatalf("stopped rows %+v", stopped)
	}
}

func TestSelectMachines(t *testing.T) {
	machines := []Machine{
		{ID: "vm1", Host: "vm1", Name: "Build box"},
		{ID: "vm2", Host: "vm2", Name: "vm2"},
		// Named like another machine's id: the id wins.
		{ID: "gpu", Host: "gpu", Name: "vm1"},
	}
	ids := func(ms []Machine) []string {
		out := []string{}
		for _, m := range ms {
			out = append(out, m.ID)
		}
		return out
	}
	cases := []struct {
		name             string
		include, exclude []string
		wantMain         bool
		wantIDs          []string
	}{
		{"nothing named: every machine and the main", nil, nil, true, []string{"vm1", "vm2", "gpu"}},
		{"by id", []string{"vm2"}, nil, false, []string{"vm2"}},
		{"by name, any case", []string{"build BOX"}, nil, false, []string{"vm1"}},
		{"main alone", []string{"main"}, nil, true, []string{}},
		{"an id beats a name", []string{"vm1"}, nil, false, []string{"vm1"}},
		{"exclude from all", nil, []string{"main", "gpu"}, false, []string{"vm1", "vm2"}},
	}
	for _, c := range cases {
		withMain, picked, err := SelectMachines(machines, c.include, c.exclude)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if withMain != c.wantMain || !reflect.DeepEqual(ids(picked), c.wantIDs) {
			t.Errorf("%s: got (%v, %v), want (%v, %v)", c.name, withMain, ids(picked), c.wantMain, c.wantIDs)
		}
	}
	_, _, err := SelectMachines(machines, []string{"nope"}, nil)
	if err == nil || err.Error() != `no machine "nope" (known: main, vm1, vm2, gpu)` {
		t.Fatalf("unknown machine: %v", err)
	}
	if _, _, err := SelectMachines(machines, nil, []string{"nope"}); err == nil {
		t.Fatal("an unknown exclude must fail too")
	}
}

func TestAddMachineNeverTakesMain(t *testing.T) {
	saved := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = saved })
	m, err := AddMachine("dev@main", "")
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != "main-2" {
		t.Fatalf("id %q: main names the main's own log", m.ID)
	}
}
