package voice

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// Machine is another machine a main's Voice OS drives over SSH. machines.json
// is the one list: the page, voice and `crew voice machines` all write it, and
// a running Voice OS reads it again when it changes.
type Machine struct {
	ID   string `json:"id"`
	Host string `json:"host"`
	Name string `json:"name"`
}

// MachineRow is a machine with what the running Voice OS last said of it.
type MachineRow struct {
	Machine
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// LocalMachine is the id a main's own sessions use in views: never a machine's.
const LocalMachine = "local"

// validHost is what ssh is given as its destination: an alias or user@host,
// never something it could read as an option. Voice OS checks the same.
var validHost = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._@-]{0,199}$`)

var unsafeID = regexp.MustCompile(`[^a-z0-9-]+`)

var ipv4 = regexp.MustCompile(`^\d+(\.\d+){3}$`)

const maxIDBase = 56

func MachinesFile() string { return filepath.Join(Dir(), "machines.json") }

func ValidHost(host string) bool { return validHost.MatchString(host) }

// MachineIDFor derives a machine's id from its host, as Voice OS does
// (shared/machines.ts machineIdFor): the host's first label, made safe,
// numbered when taken. Pure.
func MachineIDFor(host string, taken []string) string {
	if at := strings.Index(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	// An IP address is kept whole ("10-0-0-5"): its first part alone would be a
	// bare number, which collides and sorts as an index on the Voice OS side.
	label := host
	if !ipv4.MatchString(host) {
		label = strings.SplitN(host, ".", 2)[0]
	}
	// Capped so a numbered id still fits the 64 characters Voice OS allows.
	base := unsafeID.ReplaceAllString(strings.ToLower(label), "-")
	if len(base) > maxIDBase {
		base = base[:maxIDBase]
	}
	base = strings.Trim(base, "-")
	if base == "" {
		base = "remote"
	}
	reserved := map[string]bool{LocalMachine: true}
	for _, id := range taken {
		reserved[id] = true
	}
	if !reserved[base] {
		return base
	}
	for n := 2; ; n++ {
		if id := fmt.Sprintf("%s-%d", base, n); !reserved[id] {
			return id
		}
	}
}

func ReadMachines() ([]Machine, error) {
	data, err := os.ReadFile(MachinesFile())
	if os.IsNotExist(err) {
		return []Machine{}, nil
	}
	if err != nil {
		return nil, err
	}
	var machines []Machine
	if err := json.Unmarshal(data, &machines); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", MachinesFile(), err)
	}
	if machines == nil {
		machines = []Machine{}
	}
	return machines, nil
}

// updateMachines is every read-modify-write of machines.json: under a lock,
// written aside and renamed in, so a running Voice OS never reads half a file.
func updateMachines(change func([]Machine) ([]Machine, error)) error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(MachinesFile()+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	machines, err := ReadMachines()
	if err != nil {
		return err
	}
	next, err := change(machines)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	partial := fmt.Sprintf("%s.%d.tmp", MachinesFile(), os.Getpid())
	if err := os.WriteFile(partial, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(partial, MachinesFile()); err != nil {
		os.Remove(partial)
		return err
	}
	debug.Log("voice", "machines.json: %d machines", len(next))
	return nil
}

// AddMachine records a machine and returns it; the name defaults to its id.
func AddMachine(host, name string) (Machine, error) {
	host = strings.TrimSpace(host)
	if !ValidHost(host) {
		return Machine{}, fmt.Errorf("%q is not an SSH host (an alias from ~/.ssh/config, or user@host)", host)
	}
	var added Machine
	err := updateMachines(func(machines []Machine) ([]Machine, error) {
		taken := make([]string, 0, len(machines))
		for _, m := range machines {
			if m.Host == host {
				return nil, fmt.Errorf("%s already connects to %s", m.ID, host)
			}
			taken = append(taken, m.ID)
		}
		added = Machine{ID: MachineIDFor(host, taken), Host: host, Name: strings.TrimSpace(name)}
		if added.Name == "" {
			added.Name = added.ID
		}
		return append(machines, added), nil
	})
	return added, err
}

func RemoveMachine(id string) error {
	return updateMachines(func(machines []Machine) ([]Machine, error) {
		kept := []Machine{}
		for _, m := range machines {
			if m.ID != id {
				kept = append(kept, m)
			}
		}
		if len(kept) == len(machines) {
			return nil, fmt.Errorf("no machine %q (crew voice machines ls)", id)
		}
		return kept, nil
	})
}

func RenameMachine(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("say the new name")
	}
	return updateMachines(func(machines []Machine) ([]Machine, error) {
		for i, m := range machines {
			if m.ID == id {
				machines[i].Name = name
				return machines, nil
			}
		}
		return nil, fmt.Errorf("no machine %q (crew voice machines ls)", id)
	})
}

type recordedMachines struct {
	Machines map[string]struct {
		Status string `json:"status"`
		Detail string `json:"detail"`
	} `json:"machines"`
}

// MachineRows is each machine with its status as the running Voice OS
// recorded it; stopped when Voice OS is not running.
func MachineRows() ([]MachineRow, error) {
	machines, err := ReadMachines()
	if err != nil {
		return nil, err
	}
	var recorded recordedMachines
	isRunning := CockpitRunning()
	if isRunning {
		if data, err := os.ReadFile(filepath.Join(Dir(), "state.json")); err == nil {
			if err := json.Unmarshal(data, &recorded); err != nil {
				debug.Log("voice", "state.json unreadable: %v", err)
			}
		}
	}
	return machineRows(machines, recorded, isRunning), nil
}

// machineRows joins the list with what Voice OS recorded. Pure.
func machineRows(machines []Machine, recorded recordedMachines, isRunning bool) []MachineRow {
	rows := make([]MachineRow, 0, len(machines))
	for _, m := range machines {
		row := MachineRow{Machine: m, Status: "stopped"}
		if isRunning {
			row.Status = "connecting"
			if r, ok := recorded.Machines[m.ID]; ok {
				row.Status, row.Detail = r.Status, r.Detail
			}
		}
		rows = append(rows, row)
	}
	return rows
}
