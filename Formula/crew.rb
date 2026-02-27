class Crew < Formula
  desc "Agent team launcher, workspace manager & package registry"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.26.5.tar.gz"
  sha256 "4427f331cf8c642e44a5d82812bc47015cee685f65ae8ac3ddce2abd94d89acb"
  license "MIT"

  def install
    cd "crew" do
      system "go", "build", "-ldflags", "-s -w -X main.Version=#{version}", "-o", bin/"crew", "./main.go"
    end
  end

  test do
    assert_match "crew", shell_output("#{bin}/crew --version")
  end
end
