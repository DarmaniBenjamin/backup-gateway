//go:build !windows

package main

import "errors"

func isAdmin() bool { return true }

func relaunchAsAdmin(string) error { return errors.New("only on Windows") }
