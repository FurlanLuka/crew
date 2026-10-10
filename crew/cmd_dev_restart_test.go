package main

import "testing"

func TestParseRestartArgs(t *testing.T) {
	cases := []struct {
		args    []string
		want    restartArgs
		wantErr bool
	}{
		{nil, restartArgs{}, false},
		{[]string{"--proxy"}, restartArgs{Proxy: proxyOn}, false},
		{[]string{"--no-proxy"}, restartArgs{Proxy: proxyOff}, false},
		{[]string{"api/web"}, restartArgs{Server: "api/web"}, false},
		{[]string{"web"}, restartArgs{Server: "web"}, false},
		{[]string{"api/web", "--proxy"}, restartArgs{}, true},
		{[]string{"web", "worker"}, restartArgs{}, true},
		{[]string{"--wat"}, restartArgs{}, true},
	}
	for _, c := range cases {
		got, err := parseRestartArgs(c.args)
		if (err != nil) != c.wantErr || (!c.wantErr && got != c.want) {
			t.Errorf("%v = %+v, %v", c.args, got, err)
		}
	}
}

func TestNoProxyFor(t *testing.T) {
	cases := []struct {
		mode       proxyMode
		wasProxied bool
		want       bool
	}{
		{proxyOn, false, false},
		{proxyOff, true, true},
		{proxyKeep, true, false},
		{proxyKeep, false, true},
	}
	for _, c := range cases {
		if got := noProxyFor(c.mode, c.wasProxied); got != c.want {
			t.Errorf("noProxyFor(%v, %v) = %v", c.mode, c.wasProxied, got)
		}
	}
}
