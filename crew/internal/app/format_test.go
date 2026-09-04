package app

import "testing"

func TestFormatBytes(t *testing.T) {
	tests := map[int64]string{
		0:                  "0 B",
		512:                "512 B",
		1024:               "1.0 KB",
		9728:               "9.5 KB",
		10240:              "10 KB",
		49 * 1024 * 1024:   "49 MB",
		1610612736:         "1.5 GB",
		161 << 30:          "161 GB",
		3 * 1024 * 1 << 40: "3.0 PB",
	}
	for n, want := range tests {
		if got := FormatBytes(n); got != want {
			t.Errorf("FormatBytes(%d) = %q, want %q", n, got, want)
		}
	}
}
