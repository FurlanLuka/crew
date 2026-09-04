// Package dirsize sums what a directory tree holds on disk.
package dirsize

import (
	"io/fs"
	"path/filepath"
)

// Of walks path and adds up regular-file sizes. Symlinks are not followed,
// so a checkout that links into another tree is not counted twice. Unreadable
// entries are skipped rather than failing the whole sum — a partial number
// still says "large".
func Of(path string) int64 {
	var total int64
	filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}
