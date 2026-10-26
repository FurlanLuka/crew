package voice

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func pinPhoneKey(t *testing.T, key string) {
	t.Helper()
	saved := newPhoneKey
	newPhoneKey = func() (string, error) { return key, nil }
	t.Cleanup(func() { newPhoneKey = saved })
}

// A machine with a remembered port and no proxy or tailnet: links go to localhost.
func localOnly(t *testing.T) {
	t.Helper()
	noProxy(t)
	if err := saveState(savedState{Port: 7300}); err != nil {
		t.Fatal(err)
	}
}

func noProxy(t *testing.T) {
	t.Helper()
	isolateConfig(t)
	saved := proxyServesVoice
	proxyServesVoice = func() bool { return false }
	t.Cleanup(func() { proxyServesVoice = saved })
}

func TestAddPhone_StoresTheHashNeverTheKey(t *testing.T) {
	localOnly(t)
	pinPhoneKey(t, "KEYKEYKEY")

	added, err := AddPhone("")
	if err != nil {
		t.Fatal(err)
	}
	if added.Link != "http://localhost:7300/phone/KEYKEYKEY" || added.Via != ViaLocal || added.Address != "localhost:7300" || added.Name != "Phone" {
		t.Errorf("added = %+v", added)
	}
	if len(added.ID) != 7 || !strings.HasPrefix(added.ID, "p") {
		t.Errorf("id = %q, want p<6 hex>", added.ID)
	}
	data, err := os.ReadFile(PhonesFile())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "KEYKEYKEY") {
		t.Error("phones.json holds the key itself")
	}
	phones, _ := ReadPhones()
	if len(phones) != 1 || phones[0].KeySHA256 != HashPhoneKey("KEYKEYKEY") || phones[0].Created == "" {
		t.Errorf("phones = %+v", phones)
	}
}

func TestAddPhone_NamesDefaultAndRefuseATakenOne(t *testing.T) {
	localOnly(t)
	pinPhoneKey(t, "k")
	var names []string
	for range 3 {
		added, err := AddPhone("")
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, added.Name)
	}
	if want := []string{"Phone", "Phone 2", "Phone 3"}; !reflect.DeepEqual(names, want) {
		t.Errorf("names = %v, want %v", names, want)
	}
	if _, err := AddPhone("phone 2"); err == nil {
		t.Error("a taken name was accepted")
	}
	if added, err := AddPhone("Work phone"); err != nil || added.Name != "Work phone" {
		t.Errorf("given name = %+v, %v", added, err)
	}
}

func TestAddPhone_NoAddressRecordsNothing(t *testing.T) {
	noProxy(t)
	if _, err := AddPhone(""); err == nil {
		t.Fatal("added with no server ever started")
	}
	if _, err := os.Stat(PhonesFile()); !os.IsNotExist(err) {
		t.Error("phones.json written for a phone with no link")
	}
}

func TestRemovePhone(t *testing.T) {
	localOnly(t)
	pinPhoneKey(t, "k")
	a, _ := AddPhone("")
	b, _ := AddPhone("")
	if err := RemovePhone(a.ID); err != nil {
		t.Fatal(err)
	}
	phones, _ := ReadPhones()
	if len(phones) != 1 || phones[0].ID != b.ID {
		t.Errorf("phones = %+v", phones)
	}
	err := RemovePhone("pnope00")
	if err == nil || !strings.Contains(err.Error(), b.ID) {
		t.Errorf("unknown id error = %v, want it to name %s", err, b.ID)
	}
}

func TestPhoneBase_TailscaleThenProxyThenLocal(t *testing.T) {
	proxy := proxyLink{Domain: "192.168.1.20.nip.io", Port: 80, HTTPSPort: 443, TLSUp: true}
	for _, tc := range []struct {
		name      string
		reach     phoneReach
		base, via string
	}{
		{"tailscale", phoneReach{TailscaleURL: "https://mac.tail1.ts.net", ProxyServes: true, Proxy: proxy, LocalPort: 7300}, "https://mac.tail1.ts.net", ViaTailscale},
		{"proxy https", phoneReach{ProxyServes: true, Proxy: proxy, LocalPort: 7300}, "https://voice--os.192.168.1.20.nip.io", ViaProxy},
		{"proxy http", phoneReach{ProxyServes: true, Proxy: proxyLink{Domain: "192.168.1.20.nip.io", Port: 8080}, LocalPort: 7300}, "http://voice--os.192.168.1.20.nip.io:8080", ViaProxy},
		{"local", phoneReach{LocalPort: 7300}, "http://localhost:7300", ViaLocal},
	} {
		base, via, err := phoneBase(tc.reach)
		if err != nil || base != tc.base || via != tc.via {
			t.Errorf("%s: phoneBase = %q, %q, %v; want %q, %q", tc.name, base, via, err, tc.base, tc.via)
		}
	}
	if _, _, err := phoneBase(phoneReach{}); err == nil {
		t.Error("no port and no proxy gave a base")
	}
}

func TestAddPhone_TailscaleWins(t *testing.T) {
	localOnly(t)
	pinPhoneKey(t, "k")
	os.WriteFile(TailscaleFile(), []byte(`{"host":"mac.tail1.ts.net","url":"https://mac.tail1.ts.net"}`), 0o600)
	added, err := AddPhone("")
	if err != nil {
		t.Fatal(err)
	}
	if added.Link != "https://mac.tail1.ts.net/phone/k" || added.Via != ViaTailscale || added.Address != "mac.tail1.ts.net" {
		t.Errorf("added = %+v", added)
	}
}

func TestPhoneRows_JoinWhatVoiceOSSaw(t *testing.T) {
	localOnly(t)
	pinPhoneKey(t, "k")
	a, _ := AddPhone("")
	b, _ := AddPhone("")
	os.WriteFile(filepath.Join(Dir(), "phones-seen.json"), []byte(`{"`+a.ID+`":{"seen":"2026-10-02T09:30:00Z","device":"iPhone"}}`), 0o600)

	rows, err := PhoneRows()
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Device != "iPhone" || rows[0].LastSeen != "2026-10-02T09:30:00Z" || rows[1].Device != "" {
		t.Errorf("rows = %+v", rows)
	}
	if got := FormatPhoneRow(rows[1]); got != b.ID+"\tPhone 2\t"+rows[1].Created+"\t-\t-" {
		t.Errorf("row = %q", got)
	}
}

func TestPhoneRows_EmptyIsAnEmptyList(t *testing.T) {
	isolateConfig(t)
	rows, err := PhoneRows()
	if err != nil || rows == nil || len(rows) != 0 {
		t.Errorf("rows = %#v, %v", rows, err)
	}
}

// The page and a terminal can add at once; the lock keeps both.
func TestAddPhone_ConcurrentAddsBothLand(t *testing.T) {
	localOnly(t)
	pinPhoneKey(t, "k")
	const n = 8
	errs := make(chan error, n)
	for range n {
		go func() {
			_, err := AddPhone("")
			errs <- err
		}()
	}
	for range n {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	phones, _ := ReadPhones()
	if len(phones) != n {
		t.Errorf("%d phones recorded, want %d", len(phones), n)
	}
}
