// BackupAgentSetup.exe: the "download and double-click" way to install the backup agent on Windows.
//
// It's the same for every device. When you download it from the gateway (Devices > Add device >
// Windows), the gateway adds that device's one-time install link to the end of the file. This
// program reads the link back, asks Windows for administrator rights, and runs the same PowerShell
// install as the one-line command: download the agent from the gateway, check its SHA-256,
// install it as a background task, enroll. No settings to type.
//
// Built with:  npm run build-windows-setup   (in gateway/, needs Go)
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
)

const magic = "BGSETUP1"

// What the gateway appends: [JSON][8-byte length, big-endian][BGSETUP1]
type setupInfo struct {
	Script  string `json:"script"`  // install script URL on the gateway (one-time link)
	Client  string `json:"client"`  // client name, just for the message
	Expires string `json:"expires"` // when the link stops working
}

var safeURL = regexp.MustCompile(`^https?://[^\s'"` + "`" + `]+$`)

func readTrailer(path string) (*setupInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() < 16 {
		return nil, errors.New("too small")
	}
	tail := make([]byte, 16)
	if _, err := f.ReadAt(tail, st.Size()-16); err != nil {
		return nil, err
	}
	if string(tail[8:]) != magic {
		return nil, errors.New("no install link")
	}
	n := binary.BigEndian.Uint64(tail[:8])
	if n == 0 || n > 64*1024 || int64(n) > st.Size()-16 {
		return nil, errors.New("bad install link")
	}
	data := make([]byte, n)
	if _, err := f.ReadAt(data, st.Size()-16-int64(n)); err != nil {
		return nil, err
	}
	var info setupInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}
	if !safeURL.MatchString(info.Script) {
		return nil, errors.New("bad install link")
	}
	return &info, nil
}

func pause() {
	fmt.Print("\nPress Enter to close this window.")
	bufio.NewReader(os.Stdin).ReadString('\n')
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Println("Can't find this installer's own file:", err)
		pause()
		os.Exit(1)
	}
	info, err := readTrailer(exe)
	if err != nil {
		fmt.Println("This installer doesn't have an install link in it.")
		fmt.Println("Download it from the gateway's web UI: Devices > Add device > Windows PC.")
		pause()
		os.Exit(1)
	}

	if !isAdmin() {
		// Ask Windows for administrator rights (the usual "allow changes" prompt) and start again
		if err := relaunchAsAdmin(exe); err != nil {
			fmt.Println("The installer needs administrator rights:", err)
			pause()
			os.Exit(1)
		}
		return
	}

	fmt.Printf("Backup agent setup for %s\n", info.Client)
	if info.Expires != "" {
		fmt.Printf("(this installer works once, until %s)\n", info.Expires)
	}
	fmt.Println()
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
		fmt.Sprintf("irm '%s' | iex", info.Script))
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			fmt.Println("Couldn't start PowerShell:", err)
		}
	}
	pause()
}

// For tests: go run . --read FILE prints the install link found in FILE
func init() {
	if len(os.Args) == 3 && os.Args[1] == "--read" {
		info, err := readTrailer(os.Args[2])
		if err != nil {
			fmt.Println("error:", err)
			os.Exit(1)
		}
		out, _ := json.Marshal(info)
		io.WriteString(os.Stdout, string(out)+"\n")
		os.Exit(0)
	}
}
