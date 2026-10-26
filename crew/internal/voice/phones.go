package voice

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// Phone is one phone allowed into Voice OS by its link. Only the key's hash is
// kept: the link is shown once, and a copy of phones.json never lets anyone in.
type Phone struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	KeySHA256 string `json:"key_sha256"`
	Created   string `json:"created"`
}

type phonesFile struct {
	Phones []Phone `json:"phones"`
}

// PhoneSeen is one phone's entry in phones-seen.json, written by Voice OS.
type PhoneSeen struct {
	Seen   string `json:"seen"`
	Device string `json:"device"`
}

// PhoneRow is `crew server phones ls`: a phone and when Voice OS last saw it.
type PhoneRow struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Created  string `json:"created"`
	Device   string `json:"device,omitempty"`
	LastSeen string `json:"last_seen,omitempty"`
}

// PhoneAdded is what `crew server phones add` prints: the link, the one time it exists.
type PhoneAdded struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Link    string `json:"link"`
	Address string `json:"address"`
	Via     string `json:"via"`
}

// How a phone reaches Voice OS, best first.
const (
	ViaTailscale = "tailscale"
	ViaProxy     = "proxy"
	ViaLocal     = "local"
)

const defaultPhoneName = "Phone"

func PhonesFile() string     { return filepath.Join(Dir(), "phones.json") }
func PhonesSeenFile() string { return filepath.Join(Dir(), "phones-seen.json") }

// newPhoneKey is a var so tests pin the key a link carries.
var newPhoneKey = func() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func newPhoneID(phones []Phone) (string, error) {
	for {
		b := make([]byte, 3)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		id := "p" + hex.EncodeToString(b)
		if findPhone(phones, id) < 0 {
			return id, nil
		}
	}
}

// HashPhoneKey is how a key is kept and checked: sha256, hex. Pure.
func HashPhoneKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// PhoneName is a given name as is, or "Phone", then "Phone 2"… when taken. Pure.
func PhoneName(given string, phones []Phone) (string, error) {
	taken := map[string]bool{}
	for _, p := range phones {
		taken[strings.ToLower(p.Name)] = true
	}
	if given = strings.TrimSpace(given); given != "" {
		if taken[strings.ToLower(given)] {
			return "", fmt.Errorf("a phone is already called %s — pick another --name", given)
		}
		return given, nil
	}
	name := defaultPhoneName
	for n := 2; taken[strings.ToLower(name)]; n++ {
		name = fmt.Sprintf("%s %d", defaultPhoneName, n)
	}
	return name, nil
}

func findPhone(phones []Phone, id string) int {
	for i, p := range phones {
		if p.ID == id {
			return i
		}
	}
	return -1
}

func ReadPhones() ([]Phone, error) {
	f, err := readJSONFile[phonesFile](PhonesFile())
	if err != nil {
		return nil, err
	}
	if f == nil || f.Phones == nil {
		return []Phone{}, nil
	}
	return f.Phones, nil
}

// updatePhones is every read-modify-write of phones.json: under a lock, so the
// page and a terminal adding at once both land, and renamed in, so a watching
// Voice OS never reads half a file.
func updatePhones(change func([]Phone) ([]Phone, error)) error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(PhonesFile()+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	phones, err := ReadPhones()
	if err != nil {
		return err
	}
	phones, err = change(phones)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(phonesFile{Phones: phones}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(PhonesFile(), append(data, '\n'))
}

// AddPhone records a new phone and returns its link. The base is decided first,
// so a machine no phone could reach records nothing.
func AddPhone(name string) (PhoneAdded, error) {
	base, via, err := phoneBase(currentPhoneReach())
	if err != nil {
		return PhoneAdded{}, err
	}
	key, err := newPhoneKey()
	if err != nil {
		return PhoneAdded{}, err
	}
	var added Phone
	err = updatePhones(func(phones []Phone) ([]Phone, error) {
		picked, err := PhoneName(name, phones)
		if err != nil {
			return nil, err
		}
		id, err := newPhoneID(phones)
		if err != nil {
			return nil, err
		}
		added = Phone{ID: id, Name: picked, KeySHA256: HashPhoneKey(key), Created: time.Now().UTC().Format(time.RFC3339)}
		return append(phones, added), nil
	})
	if err != nil {
		return PhoneAdded{}, err
	}
	debug.Log("voice", "phones: added %s via %s", added.ID, via)
	return PhoneAddedFor(added, base, via, key), nil
}

// PhoneAddedFor is the add document: the link is <base>/phone/<key>. Pure.
func PhoneAddedFor(p Phone, base, via, key string) PhoneAdded {
	return PhoneAdded{ID: p.ID, Name: p.Name, Link: base + "/phone/" + key, Address: hostOf(base), Via: via}
}

func hostOf(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	}
	return u.Host
}

// phoneReach is what decides a phone link's base, read from disk and the proxy.
type phoneReach struct {
	TailscaleURL string
	ProxyServes  bool // the proxy answers for Voice OS under a name another device resolves
	Proxy        proxyLink
	LocalPort    int
}

// proxyServesVoice is a var so tests never see the developer's live proxy.
var proxyServesVoice = ProxyRouteAnswers

func currentPhoneReach() phoneReach {
	r := phoneReach{LocalPort: loadSaved().Port}
	if ts, err := readJSONFile[TailscaleServe](TailscaleFile()); err == nil && ts != nil {
		r.TailscaleURL = ts.URL
	}
	if r.TailscaleURL == "" && proxyServesVoice() {
		domain, port, httpsPort := proxySettings()
		r.ProxyServes = true
		r.Proxy = proxyLink{Domain: domain, Port: port, HTTPSPort: httpsPort, TLSUp: dev.ProxyServesTLS(domain, httpsPort)}
	}
	return r
}

// phoneBase: Tailscale when Voice OS is served on the tailnet (HTTPS from
// anywhere), else the dev proxy (the LAN), else localhost (this machine only).
// Pure.
func phoneBase(r phoneReach) (base, via string, err error) {
	switch {
	case r.TailscaleURL != "":
		return strings.TrimSuffix(r.TailscaleURL, "/"), ViaTailscale, nil
	case r.ProxyServes:
		link, _ := proxyLoginURL(r.Proxy)
		return strings.TrimSuffix(link, "/"), ViaProxy, nil
	case r.LocalPort > 0:
		return strings.TrimSuffix(LoginURL("http", "localhost", r.LocalPort, ""), "/"), ViaLocal, nil
	}
	return "", "", errors.New("crew's server has not started on this machine yet, so there is no address to link to — run crew server start first")
}

// PhoneViaLine is the human line after a link: where it works. Pure.
func PhoneViaLine(via string) string {
	switch via {
	case ViaTailscale:
		return "via Tailscale: works on any device signed in to your tailnet. Open it on the phone; it is shown only now."
	case ViaProxy:
		return "via the dev proxy: works on a phone on the same network. Open it on the phone; it is shown only now."
	}
	return "via localhost: works on this machine only — crew server tailscale serve makes it reach your phone. It is shown only now."
}

// PhoneRows joins phones.json with what Voice OS last saw of each.
func PhoneRows() ([]PhoneRow, error) {
	phones, err := ReadPhones()
	if err != nil {
		return nil, err
	}
	seen, err := readJSONFile[map[string]PhoneSeen](PhonesSeenFile())
	if err != nil {
		return nil, err
	}
	var seenBy map[string]PhoneSeen
	if seen != nil {
		seenBy = *seen
	}
	return phoneRows(phones, seenBy), nil
}

func phoneRows(phones []Phone, seen map[string]PhoneSeen) []PhoneRow {
	rows := make([]PhoneRow, 0, len(phones))
	for _, p := range phones {
		s := seen[p.ID]
		rows = append(rows, PhoneRow{ID: p.ID, Name: p.Name, Created: p.Created, Device: s.Device, LastSeen: s.Seen})
	}
	return rows
}

// FormatPhoneRow is one ls line: <id>\t<name>\t<created>\t<device|->\t<last_seen|->. Pure.
func FormatPhoneRow(r PhoneRow) string {
	return strings.Join([]string{r.ID, r.Name, r.Created, orDash(r.Device), orDash(r.LastSeen)}, "\t")
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// RemovePhone drops a phone; its link stops working at once.
func RemovePhone(id string) error {
	err := updatePhones(func(phones []Phone) ([]Phone, error) {
		i := findPhone(phones, id)
		if i < 0 {
			return nil, unknownPhone(id, phones)
		}
		return append(phones[:i], phones[i+1:]...), nil
	})
	if err == nil {
		debug.Log("voice", "phones: removed %s", id)
	}
	return err
}

func unknownPhone(id string, phones []Phone) error {
	if len(phones) == 0 {
		return fmt.Errorf("no phone %s: none is added (crew server phones add)", id)
	}
	ids := make([]string, 0, len(phones))
	for _, p := range phones {
		ids = append(ids, p.ID)
	}
	sort.Strings(ids)
	return fmt.Errorf("no phone %s; the phones are %s", id, strings.Join(ids, ", "))
}
